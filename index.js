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
const MAX_CACHE = 1000

const messageCache = new Map()
const savedStatusKeys = new Set()
const activePresenceChats = new Set()

fs.mkdirSync(DATA_DIR, { recursive: true })

let settings = {
  autoStatusView: true,
  saveViewedStatusToSelf: true,
  autoStatusLike: true,
  antiDelete: true,
  antiDeleteMode: 'p',
  alwaysOnline: true,
  autoTyping: false,
  autoRecording: false,
  autoViewOnce: false
}

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = {
      ...settings,
      ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    }
  }
} catch (error) {
  console.error('Settings error:', error.message)
}

const saveSettings = () =>
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))

// FORCE FEATURES ON AT STARTUP
Object.assign(settings, {
  autoStatusView: true,
  saveViewedStatusToSelf: true,
  autoStatusLike: true,
  antiDelete: true,
  antiDeleteMode: 'p',
  alwaysOnline: true,
  autoTyping: true,
  autoRecording: false,
  autoViewOnce: true
})

saveSettings()

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })

let onlineHeartbeat = null
let presenceHeartbeat = null

function unwrapMessage(message) {
  let current = message

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message
    } else {
      break
    }
  }

  return current
}

function getText(message) {
  const m = unwrapMessage(message.message || {})

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim()
}

function cacheMessage(message) {
  if (!message?.key?.id || !message.message) return

  const key = `${message.key.remoteJid}:${message.key.id}`
  messageCache.set(key, message)

  console.log('📥 MESSAGE CACHED:', key)

  if (messageCache.size > MAX_CACHE) {
    messageCache.delete(messageCache.keys().next().value)
  }
}

function getCachedMessage(key) {
  const exactKey = `${key.remoteJid}:${key.id}`
  const exact = messageCache.get(exactKey)

  if (exact?.message) return exact

  // LID mismatch fallback
  for (const cached of messageCache.values()) {
    if (cached?.key?.id === key.id && cached?.message) {
      console.log('✅ CACHE FOUND BY MESSAGE ID (LID fallback)')
      return cached
    }
  }

  return null
}

function getSelfJid(sock) {
  const raw = sock.user?.id || ''
  const number = raw.split(':')[0]

  return number ? `${number}@s.whatsapp.net` : null
}

async function sendToSelf(sock, content) {
  const jid = getSelfJid(sock)

  if (!jid) {
    console.log('❌ Self JID not available')
    return
  }

  await sock.sendMessage(jid, content)
}

// ANTI DELETE
async function sendAntiDelete(sock, protocolMessage) {
  const key = protocolMessage?.key

  if (!key?.id || !key.remoteJid || !settings.antiDelete) return

  const isGroup = key.remoteJid.endsWith('@g.us')

  if (settings.antiDeleteMode === 'p' && isGroup) return
  if (settings.antiDeleteMode === 'g' && !isGroup) return

  console.log('🗑️ DELETE EVENT:', key.remoteJid, key.id)

  const cached = getCachedMessage(key)

  if (!cached?.message) {
    console.log('❌ MESSAGE NOT FOUND IN CACHE:', key.id)
    return
  }

  const body = unwrapMessage(cached.message)
  const type = getContentType(body)

  const sender =
    key.participant ||
    cached.key?.participant ||
    cached.key?.remoteJid ||
    key.remoteJid

  const label = `🗑️ Deleted message\nFrom: @${sender.split('@')[0]}`

  try {
    if (type === 'conversation' || type === 'extendedTextMessage') {
      const text =
        body.conversation ||
        body.extendedTextMessage?.text ||
        ''

      await sendToSelf(sock, {
        text: `${label}\n\n${text}`,
        mentions: [sender]
      })
    } else if (type && body[type]) {
      const media = body[type]

      const stream = await downloadContentFromMessage(
        media,
        type.replace('Message', '').toLowerCase()
      )

      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)

      const buffer = Buffer.concat(chunks)
      const caption =
        `${label}${media.caption ? `\n\n${media.caption}` : ''}`

      if (type === 'imageMessage') {
        await sendToSelf(sock, {
          image: buffer,
          caption,
          mentions: [sender]
        })
      } else if (type === 'videoMessage') {
        await sendToSelf(sock, {
          video: buffer,
          caption,
          mentions: [sender]
        })
      } else if (type === 'audioMessage') {
        await sendToSelf(sock, {
          audio: buffer,
          mimetype: media.mimetype || 'audio/mpeg',
          ptt: !!media.ptt
        })
      } else if (type === 'stickerMessage') {
        await sendToSelf(sock, { sticker: buffer })
      } else {
        await sendToSelf(sock, {
          text: `${label}\nMedia type: ${type}`
        })
      }
    }

    console.log('✅ DELETED MESSAGE SENT TO MESSAGE YOURSELF')
  } catch (error) {
    console.error('❌ ANTI DELETE RESTORE ERROR:', error)
  }
}

// VIEW ONCE FINDER
function findViewOnceMedia(content) {
  const visited = new Set()

  function search(node, insideViewOnce = false, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 15) return null
    if (visited.has(node)) return null

    visited.add(node)

    const wrappers = [
      'viewOnceMessage',
      'viewOnceMessageV2',
      'viewOnceMessageV2Extension'
    ]

    for (const wrapper of wrappers) {
      if (node[wrapper]?.message) {
        const result = search(node[wrapper].message, true, depth + 1)
        if (result) return result
      }
    }

    if (node.ephemeralMessage?.message) {
      const result = search(
        node.ephemeralMessage.message,
        insideViewOnce,
        depth + 1
      )

      if (result) return result
    }

    for (const type of [
      'imageMessage',
      'videoMessage',
      'audioMessage'
    ]) {
      const media = node[type]

      if (
        media &&
        typeof media === 'object' &&
        (insideViewOnce || media.viewOnce === true)
      ) {
        console.log('🔐 VIEW ONCE MEDIA DETECTED:', type)
        return { type, media }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'message' && value && typeof value === 'object') {
        const result = search(value, insideViewOnce, depth + 1)
        if (result) return result
      }
    }

    return null
  }

  return search(content)
}
// MANUAL VIEW ONCE .vv COMMAND
async function handleQuotedViewOnce(sock, message) {
  const outer = unwrapMessage(message.message || {})

  const context =
    outer.extendedTextMessage?.contextInfo ||
    outer.imageMessage?.contextInfo ||
    outer.videoMessage?.contextInfo ||
    outer.audioMessage?.contextInfo

  const quoted = context?.quotedMessage

  if (!quoted) {
    await sock.sendMessage(
      message.key.remoteJid,
      {
        text: 'View Once photo/video/audio par reply karke .vv bhejein.'
      },
      { quoted: message }
    )
    return
  }

  const found = findViewOnceMedia(quoted)

  if (!found) {
    await sock.sendMessage(
      message.key.remoteJid,
      {
        text: '❌ Quoted message mein supported View Once media nahi mila.'
      },
      { quoted: message }
    )
    return
  }

  const { type, media } = found

  try {
    console.log('🔐 MANUAL VIEW ONCE DOWNLOAD:', type)

    const mediaType = type.replace('Message', '').toLowerCase()

    const stream = await downloadContentFromMessage(
      media,
      mediaType
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    const buffer = Buffer.concat(chunks)

    if (!buffer.length) {
      throw new Error('Downloaded media is empty')
    }

    const caption = '🔓 View Once media — requested with .vv'

    if (type === 'imageMessage') {
      await sendToSelf(sock, {
        image: buffer,
        caption
      })
    } else if (type === 'videoMessage') {
      await sendToSelf(sock, {
        video: buffer,
        caption
      })
    } else if (type === 'audioMessage') {
      await sendToSelf(sock, {
        audio: buffer,
        mimetype: media.mimetype || 'audio/ogg; codecs=opus',
        ptt: !!media.ptt
      })
    }

    await sock.sendMessage(
      message.key.remoteJid,
      {
        text: '✅ View Once media Message Yourself mein bhej di.'
      },
      { quoted: message }
    )

    console.log('✅ MANUAL VIEW ONCE SAVED')

  } catch (error) {
    console.error('❌ MANUAL VIEW ONCE FAILED:', error)

    await sock.sendMessage(
      message.key.remoteJid,
      {
        text: '❌ View Once media download nahi ho saka.'
      },
      { quoted: message }
    )
  }
}
// AUTO SAVE INCOMING VIEW ONCE
async function saveIncomingViewOnceToSelf(sock, message) {
  if (!settings.autoViewOnce || message.key?.fromMe) return false

  const found = findViewOnceMedia(message.message || {})
  if (!found) return false

  const { type, media } = found

  try {
    console.log('🔐 VIEW ONCE DETECTED; downloading:', type)

    const mediaType = type.replace('Message', '').toLowerCase()
    const stream = await downloadContentFromMessage(media, mediaType)

    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    const buffer = Buffer.concat(chunks)

    if (!buffer.length) {
      throw new Error('Downloaded media is empty')
    }

    const senderJid =
      message.key?.participant ||
      message.key?.remoteJid ||
      ''

    const senderName =
      message.pushName ||
      senderJid.split('@')[0] ||
      'Unknown contact'

    const caption = `🔐 View Once received from ${senderName}`

    if (type === 'imageMessage') {
      await sendToSelf(sock, { image: buffer, caption })
    } else if (type === 'videoMessage') {
      await sendToSelf(sock, { video: buffer, caption })
    } else if (type === 'audioMessage') {
      await sendToSelf(sock, {
        audio: buffer,
        mimetype: media.mimetype || 'audio/ogg; codecs=opus',
        ptt: !!media.ptt
      })
    } else {
      return false
    }

    console.log('✅ VIEW ONCE SAVED TO MESSAGE YOURSELF')
    return true
  } catch (error) {
    console.error('❌ VIEW ONCE AUTO-SAVE FAILED:', error.message)
    return false
  }
}

// SAVE STATUS TO SELF
async function saveStatusToSelf(sock, message) {
  try {
    const body = unwrapMessage(message.message || {})
    const type = getContentType(body)

    const senderJid = message.key?.participant || ''

    const senderName =
      message.pushName ||
      message.verifiedBizName ||
      senderJid.split('@')[0]

    const caption = `📲 Status from ${senderName}`

    if (type === 'imageMessage') {
      const stream = await downloadContentFromMessage(
        body.imageMessage,
        'image'
      )

      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)

      await sendToSelf(sock, {
        image: Buffer.concat(chunks),
        caption
      })
    } else if (type === 'videoMessage') {
      const stream = await downloadContentFromMessage(
        body.videoMessage,
        'video'
      )

      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)

      await sendToSelf(sock, {
        video: Buffer.concat(chunks),
        caption
      })
    } else if (
      type === 'extendedTextMessage' ||
      type === 'conversation'
    ) {
      const text =
        body.conversation ||
        body.extendedTextMessage?.text ||
        ''

      await sendToSelf(sock, {
        text: `${caption}\n${text}`
      })
    }

    console.log('✅ STATUS COPIED TO MESSAGE YOURSELF')
  } catch (error) {
    console.error('STATUS SAVE FAILED:', error.message)
  }
}

// STATUS LIKE
async function likeStatus(sock, message) {
  try {
    const participant = message.key?.participant

    if (!participant) {
      console.log('⚠️ Status participant missing, like skipped')
      return
    }

    const result = await sock.sendMessage(
      'status@broadcast',
      {
        react: {
          text: '🤍',
          key: message.key
        }
      },
      {
        statusJidList: [participant]
      }
    )

    console.log('🤍 STATUS REACTION SUBMITTED:', participant)
    console.log('Reaction result:', result?.key?.id || 'Submitted')
  } catch (error) {
    console.error('❌ STATUS LIKE FAILED:', error)
  }
}

// CONNECT BOT
async function connect() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR)

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
      console.log('\nScan QR with WhatsApp > Linked devices:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      console.log('✅ PROFESSOR BOT CONNECTED')

      if (onlineHeartbeat) clearInterval(onlineHeartbeat)

      onlineHeartbeat = setInterval(() => {
        if (settings.alwaysOnline) {
          sock.sendPresenceUpdate('available').catch(() => {})
        }
      }, 25000)

      if (settings.alwaysOnline) {
        sock.sendPresenceUpdate('available').catch(() => {})
      }

      if (presenceHeartbeat) clearInterval(presenceHeartbeat)

      presenceHeartbeat = setInterval(() => {
        const presence = settings.autoTyping
          ? 'composing'
          : settings.autoRecording
            ? 'recording'
            : null

        if (!presence) return

        for (const jid of activePresenceChats) {
          sock.sendPresenceUpdate(presence, jid).catch(() => {})
        }
      }, 20000)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode

      if (code !== DisconnectReason.loggedOut) {
        console.log('Connection closed. Reconnecting...')
        setTimeout(connect, 3000)
      } else {
        console.log('Logged out. Auth folder ko delete na karein.')
      }
    }
  })

  // INCOMING MESSAGE EVENTS
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('📩 MESSAGES UPSERT:', type, messages.length)

    for (const message of messages) {
      if (!message) continue

      const chat = message.key?.remoteJid

      // STATUS AUTO VIEW + LIKE
      if (chat === 'status@broadcast') {
        console.log(
          '📲 STATUS EVENT RECEIVED:',
          message.key?.id,
          message.key?.participant
        )

        if (!message.message) continue

        const statusId =
          `${message.key.participant || ''}:${message.key.id || ''}`

        if (
          !message.key.fromMe &&
          !savedStatusKeys.has(statusId)
        ) {
          savedStatusKeys.add(statusId)

          if (savedStatusKeys.size > 500) {
            savedStatusKeys.delete(
              savedStatusKeys.values().next().value
            )
          }

          if (settings.autoStatusView) {
            if (settings.autoStatusLike) {
              await likeStatus(sock, message)
            }

            try {
              await sock.readMessages([message.key])
              console.log('👁️ STATUS READ RECEIPT SUBMITTED:', message.key?.id)
            } catch (error) {
              console.error('STATUS VIEW FAILED:', error.message)
            }
          }

          if (settings.saveViewedStatusToSelf) {
            await saveStatusToSelf(sock, message)
          }
        }

        continue
      }

      if (!message.message) continue

      // REVOKE / DELETE EVENT
      const unwrapped = unwrapMessage(message.message)
      const protocol = unwrapped?.protocolMessage

      if (protocol?.type === 0) {
        console.log('🗑️ REVOKE EVENT FOUND')
        await sendAntiDelete(sock, protocol)
        continue
      }

      // CACHE ORIGINAL MESSAGE
      cacheMessage(message)

      // AUTO SAVE INCOMING VIEW ONCE MEDIA
      if (settings.autoViewOnce && !message.key?.fromMe) {
        await saveIncomingViewOnceToSelf(sock, message)
      }

      // AUTO PRESENCE
      if (
        type === 'notify' &&
        !message.key.fromMe &&
        chat &&
        chat !== 'status@broadcast'
      ) {
        activePresenceChats.add(chat)

        const presence = settings.autoTyping
          ? 'composing'
          : settings.autoRecording
            ? 'recording'
            : null

        if (presence) {
          sock.sendPresenceUpdate(presence, chat).catch(() => {})
        }
      }

      // COMMANDS FROM OWN MESSAGES
      if (type !== 'notify' || !message.key.fromMe) continue

      const text = getText(message)
      if (!text.startsWith(PREFIX)) continue

      const [command, ...args] = text
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/)

      const cmd = (command || '').toLowerCase()
      const value = (args[0] || '').toLowerCase()

      if (cmd === 'vv') {
        await handleQuotedViewOnce(sock, message)

      } else if (cmd === 'status') {
        if (value === 'on') {
          settings.autoStatusView = true
          settings.saveViewedStatusToSelf = true
          settings.autoStatusLike = true
        } else if (value === 'off') {
          settings.autoStatusView = false
          settings.saveViewedStatusToSelf = false
          settings.autoStatusLike = false
        } else {
          await sock.sendMessage(chat, {
            text: `Status: ${settings.autoStatusView ? 'ON' : 'OFF'}\nUse .status on/off`
          }, { quoted: message })
          continue
        }

        saveSettings()

        await sock.sendMessage(chat, {
          text: `✅ Status Auto View + Like ${settings.autoStatusView ? 'ON' : 'OFF'}`
        }, { quoted: message })

      } else if (cmd === 'dlt' || cmd === 'delete') {
        if (value === 'p' || value === 'g') {
          settings.antiDelete = true
          settings.antiDeleteMode = value
        } else if (value === 'off') {
          settings.antiDelete = false
        } else {
          await sock.sendMessage(chat, {
            text: 'Use:\n.dlt p\n.dlt g\n.dlt off'
          }, { quoted: message })
          continue
        }

        saveSettings()

        await sock.sendMessage(chat, {
          text: `✅ Anti Delete ${settings.antiDelete ? 'ON (' + settings.antiDeleteMode + ')' : 'OFF'}`
        }, { quoted: message })

      } else if (cmd === 'online') {
        settings.alwaysOnline = value !== 'off'
        saveSettings()

        await sock.sendPresenceUpdate(
          settings.alwaysOnline ? 'available' : 'unavailable'
        ).catch(() => {})

        await sock.sendMessage(chat, {
          text: `Always Online ${settings.alwaysOnline ? 'ON' : 'OFF'}`
        }, { quoted: message })

      } else if (cmd === 'typing') {
        settings.autoTyping = value !== 'off'
        saveSettings()

        await sock.sendMessage(chat, {
          text: `Auto Typing ${settings.autoTyping ? 'ON' : 'OFF'}`
        }, { quoted: message })

      } else if (cmd === 'recording') {
        settings.autoRecording = value !== 'off'
        saveSettings()

        await sock.sendMessage(chat, {
          text: `Auto Recording ${settings.autoRecording ? 'ON' : 'OFF'}`
        }, { quoted: message })
      }
    }
  })

  // ADDITIONAL DELETE UPDATE EVENT
  sock.ev.on('messages.update', async updates => {
    if (!settings.antiDelete) return

    for (const item of updates) {
      const updateMessage = unwrapMessage(item.update?.message || {})
      const protocol = updateMessage?.protocolMessage

      if (protocol?.type === 0) {
        console.log('🗑️ DELETE EVENT FROM UPDATE')
        await sendAntiDelete(sock, protocol)
      }
    }
  })
}

connect().catch(error => {
  console.error('Fatal startup error:', error)
  process.exitCode = 1
})
