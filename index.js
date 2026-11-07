import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  getContentType
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'node:fs'
import path from 'node:path'

const PREFIX = process.env.PREFIX || '.'
const AUTH_DIR = process.env.AUTH_DIR || './auth_info'
const DATA_DIR = './data'
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const MAX_CACHE = 250
const messageCache = new Map()

fs.mkdirSync(DATA_DIR, { recursive: true })
let settings = { autoStatusView: false, antiDelete: true }
try {
  if (fs.existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
} catch (error) {
  console.error('Could not read settings:', error.message)
}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })

function unwrapMessage(message) {
  let current = message
  while (current) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message
    else break
  }
  return current
}

function getText(message) {
  const m = unwrapMessage(message.message || {})
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '').trim()
}

function cacheMessage(message) {
  if (!message?.key?.id || !message.message) return
  const key = `${message.key.remoteJid}:${message.key.id}`
  messageCache.set(key, message)
  if (messageCache.size > MAX_CACHE) messageCache.delete(messageCache.keys().next().value)
}

async function sendAntiDelete(sock, protocolMessage) {
  const key = protocolMessage?.key
  if (!key?.id || !key.remoteJid) return
  const cached = messageCache.get(`${key.remoteJid}:${key.id}`)
  if (!cached?.message) return
  const body = unwrapMessage(cached.message)
  const type = getContentType(body)
  const sender = key.participant || key.remoteJid
  const label = `🗑️ Deleted message\nFrom: @${sender.split('@')[0]}`
  try {
    if (type === 'conversation' || type === 'extendedTextMessage') {
      const text = body.conversation || body.extendedTextMessage?.text || ''
      await sock.sendMessage(key.remoteJid, { text: `${label}\n\n${text}`, mentions: [sender] })
    } else if (type && body[type]) {
      const media = body[type]
      const stream = await downloadContentFromMessage(media, type.replace('Message', '').toLowerCase())
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const caption = `${label}${media.caption ? `\n\n${media.caption}` : ''}`
      if (type === 'imageMessage') await sock.sendMessage(key.remoteJid, { image: buffer, caption, mentions: [sender] })
      else if (type === 'videoMessage') await sock.sendMessage(key.remoteJid, { video: buffer, caption, mentions: [sender] })
      else if (type === 'audioMessage') await sock.sendMessage(key.remoteJid, { audio: buffer, mimetype: media.mimetype || 'audio/mpeg', ptt: !!media.ptt })
      else if (type === 'stickerMessage') await sock.sendMessage(key.remoteJid, { sticker: buffer })
      else await sock.sendMessage(key.remoteJid, { text: `${label}\n(Media type: ${type})` })
    }
  } catch (error) {
    console.error('Anti-delete restore failed:', error.message)
  }
}

async function handleViewOnce(sock, message) {
  const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage
  if (!quoted) return sock.sendMessage(message.key.remoteJid, { text: 'Reply to a View Once photo, video or audio with .vv' }, { quoted: message })
  const body = unwrapMessage(quoted)
  const type = getContentType(body)
  if (!type || !['imageMessage', 'videoMessage', 'audioMessage'].includes(type)) {
    return sock.sendMessage(message.key.remoteJid, { text: 'Quoted message is not supported View Once media.' }, { quoted: message })
  }
  try {
    const media = body[type]
    const stream = await downloadContentFromMessage(media, type.replace('Message', '').toLowerCase())
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    if (type === 'imageMessage') await sock.sendMessage(message.key.remoteJid, { image: buffer, caption: media.caption || '' }, { quoted: message })
    if (type === 'videoMessage') await sock.sendMessage(message.key.remoteJid, { video: buffer, caption: media.caption || '' }, { quoted: message })
    if (type === 'audioMessage') await sock.sendMessage(message.key.remoteJid, { audio: buffer, mimetype: media.mimetype || 'audio/mpeg', ptt: !!media.ptt }, { quoted: message })
  } catch (error) {
    await sock.sendMessage(message.key.remoteJid, { text: `Could not retrieve media: ${error.message}` }, { quoted: message })
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch { /* use library default */ }
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan this QR with WhatsApp > Linked devices:\n')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') console.log('✅ SHAHEEN MINI BOT CONNECTED')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('Connection closed. Reconnecting...')
        setTimeout(connect, 3000)
      } else {
        console.log('Logged out. Remove auth folder and pair again.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const message of messages) {
      if (!message?.message) continue
      const chat = message.key.remoteJid
      if (chat === 'status@broadcast') {
        if (settings.autoStatusView && !message.key.fromMe) {
          try { await sock.readMessages([message.key]) } catch (error) { console.error('Status view failed:', error.message) }
        }
        continue
      }

      const protocol = unwrapMessage(message.message).protocolMessage
      if (settings.antiDelete && protocol?.type === 0) {
        await sendAntiDelete(sock, protocol)
        continue
      }
      cacheMessage(message)
      if (type !== 'notify' || !message.key.fromMe) continue

      const text = getText(message)
      if (!text.startsWith(PREFIX)) continue
      const [command, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
      const cmd = (command || '').toLowerCase()
      const value = (args[0] || '').toLowerCase()

      if (cmd === 'status') {
        if (value === 'on') settings.autoStatusView = true
        else if (value === 'off') settings.autoStatusView = false
        else return sock.sendMessage(chat, { text: `Status Auto View: ${settings.autoStatusView ? 'ON' : 'OFF'}\nUse ${PREFIX}status on/off` }, { quoted: message })
        saveSettings()
        await sock.sendMessage(chat, { text: `✅ Status Auto View ${settings.autoStatusView ? 'enabled' : 'disabled'}.` }, { quoted: message })
      } else if (cmd === 'delete') {
        settings.antiDelete = value !== 'off'
        saveSettings()
        await sock.sendMessage(chat, { text: `✅ Anti-Delete ${settings.antiDelete ? 'enabled' : 'disabled'}. Use ${PREFIX}delete on/off` }, { quoted: message })
      } else if (cmd === 'vv') {
        await handleViewOnce(sock, message)
      }
    }
  })

  sock.ev.on('messages.update', async (updates) => {
    if (!settings.antiDelete) return
    for (const item of updates) {
      const protocol = item.update?.message?.protocolMessage
      if (protocol?.type === 0) await sendAntiDelete(sock, protocol)
    }
  })
}

connect().catch(error => {
  console.error('Fatal startup error:', error)
  process.exitCode = 1
})
