import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
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
let settings = {
  autoStatusView: true,
  saveViewedStatusToSelf: true,
  antiDelete: true,
  alwaysOnline: true,
  autoTyping: false,
  autoRecording: false,
  autoViewOnce: false
}
try {
  if (fs.existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
} catch (error) {
  console.error('Could not read settings:', error.message)
}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })
const activePresenceChats = new Set()
const savedStatusKeys = new Set()
let onlineHeartbeat = null
let presenceHeartbeat = null

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
      await sendToSelf(sock, { text: `${label}\n\n${text}`, mentions: [sender] })
    } else if (type && body[type]) {
      const media = body[type]
      const stream = await downloadContentFromMessage(media, type.replace('Message', '').toLowerCase())
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const caption = `${label}${media.caption ? `\n\n${media.caption}` : ''}`
      if (type === 'imageMessage') await sendToSelf(sock, { image: buffer, caption, mentions: [sender] })
      else if (type === 'videoMessage') await sendToSelf(sock, { video: buffer, caption, mentions: [sender] })
      else if (type === 'audioMessage') await sendToSelf(sock, { audio: buffer, mimetype: media.mimetype || 'audio/mpeg', ptt: !!media.ptt })
      else if (type === 'stickerMessage') await sendToSelf(sock, { sticker: buffer })
      else await sendToSelf(sock, { text: `${label}\n(Media type: ${type})` })
    }
  } catch (error) {
    console.error('Anti-delete restore failed:', error.message)
  }
}

function findViewOnceMedia(messageContent) {
  let current = messageContent
  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message
      continue
    }
    for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
      if (current[wrapper]?.message) {
        current = current[wrapper].message
        break
      }
    }
    if (current === messageContent) break
    if (current && (current.imageMessage || current.videoMessage || current.audioMessage)) {
      const type = current.imageMessage ? 'imageMessage' : current.videoMessage ? 'videoMessage' : 'audioMessage'
      const media = current[type]
      if (media?.viewOnce || messageContent?.viewOnceMessage || messageContent?.viewOnceMessageV2 || messageContent?.viewOnceMessageV2Extension) {
        return { type, media }
      }
    }
    // A wrapper was unwrapped; continue in case it contains another wrapper.
    if (!current.ephemeralMessage && !current.viewOnceMessage && !current.viewOnceMessageV2 && !current.viewOnceMessageV2Extension) {
      const type = current.imageMessage ? 'imageMessage' : current.videoMessage ? 'videoMessage' : current.audioMessage ? 'audioMessage' : null
      if (type && current[type]?.viewOnce) return { type, media: current[type] }
      break
    }
  }
  // Also support direct media payloads with the viewOnce flag.
  const directType = messageContent?.imageMessage ? 'imageMessage' : messageContent?.videoMessage ? 'videoMessage' : messageContent?.audioMessage ? 'audioMessage' : null
  if (directType && messageContent[directType]?.viewOnce) return { type: directType, media: messageContent[directType] }
  return null
}

async function saveIncomingViewOnceToSelf(sock, message) {
  const found = findViewOnceMedia(message.message || {})
  if (!found) return false
  const { type, media } = found
  try {
    const stream = await downloadContentFromMessage(media, type.replace('Message', '').toLowerCase())
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    const senderJid = message.key?.participant || message.key?.remoteJid || ''
    const sender = senderJid.split('@')[0]
    const caption = `🔐 View Once media received from ${sender ? `@${sender}` : 'contact'} — saved to Message Yourself`
    if (type === 'imageMessage') await sendToSelf(sock, { image: buffer, caption, mentions: senderJid ? [senderJid] : [] })
    else if (type === 'videoMessage') await sendToSelf(sock, { video: buffer, caption, mentions: senderJid ? [senderJid] : [] })
    else if (type === 'audioMessage') await sendToSelf(sock, { audio: buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: !!media.ptt })
    console.log('✅ Incoming View Once media copied to Message Yourself')
    return true
  } catch (error) {
    console.error('Auto View Once save failed:', error.message)
    return false
  }
}

async function handleQuotedViewOnce(sock, message) {
  const outer = unwrapMessage(message.message || {})
  const context = outer.extendedTextMessage?.contextInfo ||
    outer.imageMessage?.contextInfo || outer.videoMessage?.contextInfo
  const quoted = context?.quotedMessage
  if (!quoted) {
    await sock.sendMessage(message.key.remoteJid, { text: 'View Once media par reply karke .vv bhejein.' }, { quoted: message })
    return
  }
  const found = findViewOnceMedia(quoted)
  if (!found) {
    await sock.sendMessage(message.key.remoteJid, { text: 'Quoted message mein supported View Once media nahi mila.' }, { quoted: message })
    return
  }
  const { type, media } = found
  try {
    const stream = await downloadContentFromMessage(media, type.replace('Message', '').toLowerCase())
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    const caption = '🔓 View Once media — requested with .vv'
    if (type === 'imageMessage') await sendToSelf(sock, { image: buffer, caption })
    else if (type === 'videoMessage') await sendToSelf(sock, { video: buffer, caption })
    else if (type === 'audioMessage') await sendToSelf(sock, { audio: buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: !!media.ptt })
    await sock.sendMessage(message.key.remoteJid, { text: ' ' }, { quoted: message })
  } catch (error) {
    console.error('Manual .vv failed:', error.message)
    await sock.sendMessage(message.key.remoteJid, { text: '❌ Media access nahi ho saka. WhatsApp/Baileys ne content expose nahi kiya.' }, { quoted: message })
  }
}

function getSelfJid(sock) {
  const raw = sock.user?.id || ''
  const number = raw.split(':')[0]
  return number ? `${number}@s.whatsapp.net` : null
}

async function sendToSelf(sock, content) {
  const jid = getSelfJid(sock)
  if (!jid) return
  await sock.sendMessage(jid, content)
}

async function saveStatusToSelf(sock, message) {
  try {
    const body = unwrapMessage(message.message || {})
    const type = getContentType(body)
    const senderJid = message.key?.participant || message.key?.remoteJid || ''
    const sender = senderJid.split('@')[0]
    const caption = `📲 Status from @${sender}`
    if (type === 'imageMessage') {
      const stream = await downloadContentFromMessage(body.imageMessage, 'image')
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      await sendToSelf(sock, { image: Buffer.concat(chunks), caption, mentions: [senderJid] })
    } else if (type === 'videoMessage') {
      const stream = await downloadContentFromMessage(body.videoMessage, 'video')
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      await sendToSelf(sock, { video: Buffer.concat(chunks), caption, mentions: [senderJid] })
    } else if (type === 'extendedTextMessage' || type === 'conversation') {
      const text = body.conversation || body.extendedTextMessage?.text || ''
      await sendToSelf(sock, { text: `${caption}\n${text}`, mentions: senderJid ? [senderJid] : [] })
    }
  } catch (error) {
    console.error('Could not save viewed status to self chat:', error.message)
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({
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
    if (connection === 'open') {
      console.log('✅ SHAHEEN MINI BOT CONNECTED')
      if (onlineHeartbeat) clearInterval(onlineHeartbeat)
      onlineHeartbeat = setInterval(() => {
        if (settings.alwaysOnline) sock.sendPresenceUpdate('available').catch(() => {})
      }, 25000)
      if (settings.alwaysOnline) sock.sendPresenceUpdate('available').catch(() => {})
      if (presenceHeartbeat) clearInterval(presenceHeartbeat)
      presenceHeartbeat = setInterval(() => {
        const presence = settings.autoTyping ? 'composing' : settings.autoRecording ? 'recording' : null
        if (!presence) return
        for (const jid of activePresenceChats) sock.sendPresenceUpdate(presence, jid).catch(() => {})
      }, 20000)
    }
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
        const statusId = `${message.key.participant || ''}:${message.key.id || ''}`
        if (!message.key.fromMe && !savedStatusKeys.has(statusId)) {
          savedStatusKeys.add(statusId)
          if (savedStatusKeys.size > 500) savedStatusKeys.delete(savedStatusKeys.values().next().value)
          if (settings.autoStatusView) {
            try { await sock.readMessages([message.key]) } catch (error) { console.error('Status view failed:', error.message) }
          }
          if (settings.saveViewedStatusToSelf) await saveStatusToSelf(sock, message)
        }
        continue
      }

      const protocol = unwrapMessage(message.message).protocolMessage
      if (settings.antiDelete && protocol?.type === 0) {
        await sendAntiDelete(sock, protocol)
        continue
      }
      cacheMessage(message)
      if (type === 'notify' && !message.key.fromMe && chat && chat !== 'status@broadcast') {
        activePresenceChats.add(chat)
        const presence = settings.autoTyping ? 'composing' : settings.autoRecording ? 'recording' : null
        if (presence) sock.sendPresenceUpdate(presence, chat).catch(() => {})
      }
      if (type !== 'notify' || !message.key.fromMe) continue

      const text = getText(message)
      if (!text.startsWith(PREFIX)) continue
      const [command, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
      const cmd = (command || '').toLowerCase()
      const value = (args[0] || '').toLowerCase()

      if (cmd === 'vv') {
        await handleQuotedViewOnce(sock, message)
      } else if (cmd === 'status') {
        if (value === 'on') { settings.autoStatusView = true; settings.saveViewedStatusToSelf = true }
        else if (value === 'off') { settings.autoStatusView = false; settings.saveViewedStatusToSelf = false }
        else return sock.sendMessage(chat, { text: `Status Auto View: ${settings.autoStatusView ? 'ON' : 'OFF'}\nUse ${PREFIX}status on/off` }, { quoted: message })
        saveSettings()
        await sock.sendMessage(chat, { text: `✅ Status Auto View ${settings.autoStatusView ? 'enabled' : 'disabled'}.` }, { quoted: message })
      } else if (cmd === 'delete') {
        settings.antiDelete = value !== 'off'
        saveSettings()
        await sock.sendMessage(chat, { text: `✅ Anti-Delete ${settings.antiDelete ? 'enabled' : 'disabled'}. Use ${PREFIX}delete on/off` }, { quoted: message })
      } else if (cmd === 'online') {
        settings.alwaysOnline = value !== 'off'
        saveSettings()
        await sock.sendPresenceUpdate(settings.alwaysOnline ? 'available' : 'unavailable').catch(() => {})
        await sock.sendMessage(chat, { text: `✅ Always Online ${settings.alwaysOnline ? 'ON' : 'OFF'}` }, { quoted: message })
      } else if (cmd === 'typing') {
        settings.autoTyping = value !== 'off'
        saveSettings()
        await sock.sendMessage(chat, { text: `✅ Auto Typing ${settings.autoTyping ? 'ON' : 'OFF'}` }, { quoted: message })
      } else if (cmd === 'recording') {
        settings.autoRecording = value !== 'off'
        saveSettings()
        await sock.sendMessage(chat, { text: `✅ Auto Recording ${settings.autoRecording ? 'ON' : 'OFF'}` }, { quoted: message })
      }
    }
  })

  sock.ev.on('messages.update', async (updates) => {
    if (!settings.antiDelete) return
    for (const item of updates) {
      const updateMessage = unwrapMessage(item.update?.message || {})
      const protocol = updateMessage.protocolMessage
      if (protocol?.type === 0) await sendAntiDelete(sock, protocol)
    }
  })
}

connect().catch(error => {
  console.error('Fatal startup error:', error)
  process.exitCode = 1
})
