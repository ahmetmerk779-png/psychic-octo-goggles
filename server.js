const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const autoEat = require('mineflayer-auto-eat').plugin;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'bot_memory.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let bot = null;
let mcData = null;
let model = null;
let currentConfig = null;

// --- Hafıza Yönetimi ---
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ basePosition: null, waypoints: {}, playerRelations: {} }, null, 2));
  }
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } 
  catch (e) { return { basePosition: null, waypoints: {}, playerRelations: {} }; }
}

function saveMemory(data) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

function updateMemoryKey(key, value) {
  const mem = loadMemory();
  mem[key] = value;
  saveMemory(mem);
  logToDashboard('MEMORY', `Hafıza güncellendi: ${key}`);
}

// --- Dashboard & Loglama ---
function logToDashboard(type, message) {
  console.log(`[${type}] ${message}`);
  io.emit('bot_log', { type, message, timestamp: new Date().toLocaleTimeString() });

  if (currentConfig && currentConfig.discordWebhook && ['ERROR', 'WARNING', 'SYSTEM'].includes(type)) {
    axios.post(currentConfig.discordWebhook, { content: `**[${type}]** ${message}` }).catch(() => {});
  }
}

function broadcastStatus() {
  if (!bot || !bot.entity) {
    io.emit('status_update', { connected: false });
    return;
  }
  const status = {
    connected: true,
    health: bot.health,
    food: bot.food,
    position: {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z)
    },
    inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count }))
  };
  io.emit('status_update', status);
}

// --- Bot Başlatma Mimarisi ---
function initBot(config) {
  if (bot) {
    logToDashboard('SYSTEM', 'Mevcut bağlantı sonlandırılıyor...');
    try { bot.quit(); } catch(e) {}
    bot = null;
  }

  currentConfig = config;

  if (config.apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(config.apiKey);
      model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    } catch (e) {
      logToDashboard('ERROR', `Gemini API Başlatılamadı: ${e.message}`);
    }
  }

  const mcVersion = (config.version && config.version !== 'auto') ? config.version.trim() : false;
  const authMode = config.auth || 'offline';

  logToDashboard('SYSTEM', `${config.host}:${config.port} sunucusuna (${config.username}) bağlanılıyor... [Sürüm: ${mcVersion || 'Otomatik'}, Mod: ${authMode}]`);

  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: parseInt(config.port) || 25565,
      username: config.username || "DynamicBot",
      version: mcVersion,
      auth: authMode
    });
  } catch (err) {
    logToDashboard('ERROR', `Bot oluşturma hatası: ${err.message}`);
    return;
  }

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(autoEat);

  bot.once('spawn', () => {
    mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = true;
    bot.pathfinder.setMovements(defaultMove);

    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14,
      bannedFood: ['rotten_flesh', 'poisonous_potato', 'pufferfish']
    };

    logToDashboard('SYSTEM', `${bot.username} sunucuya başarıyla girdi! (Minecraft v${bot.version})`);
  });

  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const attacker = bot.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && e.position.distanceTo(bot.entity.position) < 5);
    
    if (attacker) {
      logToDashboard('WARNING', `Saldırı tespit edildi! Hedef: ${attacker.name || attacker.username}`);
      const sword = bot.inventory.items().find(item => item.name.includes('sword'));
      if (sword) bot.equip(sword, 'hand');
      if (bot.pvp) bot.pvp.attack(attacker);
      else bot.attack(attacker);
    }
  });

  bot.on('kicked', (reason) => {
    logToDashboard('WARNING', `Sunucudan atıldı: ${reason}`);
  });

  bot.on('error', (err) => {
    logToDashboard('ERROR', `Sunucu Bağlantı Hatası: ${err.message}`);
  });

  bot.on('end', (reason) => {
    logToDashboard('WARNING', `Bağlantı koptu. (${reason || 'Bilinmeyen sebep'})`);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    logToDashboard('GAME_CHAT', `<${username}> ${message}`);
    
    if (message.startsWith('!ai ') || message.toLowerCase().includes(bot.username.toLowerCase())) {
      const query = message.replace('!ai ', '').replace(bot.username, '').trim();
      processRequestWithSelfCorrection(query, username);
    }
  });
}

function getEnvironmentContext() {
  if (!bot || !bot.entity) return {};
  const pos = bot.entity.position;
  const nearbyEntities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 16)
    .map(e => `${e.name || e.username} (${Math.round(e.position.distanceTo(pos))}m)`);

  return {
    position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
    health: bot.health,
    food: bot.food,
    inventory: bot.inventory.items().map(i => `${i.name} x${i.count}`).join(', ') || "Boş",
    nearbyEntities: nearbyEntities.join(', ') || "Yok",
    heldItem: bot.heldItem ? bot.heldItem.name : "Yok",
    memoryContext: JSON.stringify(loadMemory())
  };
}

// --- Self-Correction AI Döngüsü ---
async function processRequestWithSelfCorrection(userMessage, sender, retries = 3) {
  if (!model) {
    logToDashboard('ERROR', 'Gemini API Key girilmediği için AI isteği işlenemedi.');
    return;
  }

  logToDashboard('AI', `Gelen Komut [${sender}]: "${userMessage}"`);

  let lastError = null;
  let previousCode = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const env = getEnvironmentContext();

    const systemPrompt = `
Sen Mineflayer altyapısında çalışan otonom bir Minecraft botusun.
Sana verilen isteği gerçekleştirmek için Node.js / Mineflayer KODU üret.

DURUM:
- Konum: X:${env.position.x}, Y:${env.position.y}, Z:${env.position.z}
- Can: ${env.health}/20, Açlık: ${env.food}/20
- Envanter: ${env.inventory}
- Kalıcı Hafıza: ${env.memoryContext}

DEĞİŞKENLER: \`bot\`, \`mcData\`, \`goals\`, \`updateMemoryKey\`, \`logToDashboard\`

${lastError ? `
[HATA DÜZELTME MODU]
Önceki Kod:
\`\`\`javascript
${previousCode}
\`\`\`
Hata: "${lastError}"
Lütfen bu hatayı çözen DÜZELTİLMİŞ yeni kodu üret.
` : ''}

SADECE GEÇERLİ JSON DÖNDÜR:
{
  "thought": "Düşünce planı",
  "chatReply": "Oyuncuya kısa yanıt",
  "code": "async (bot, mcData, goals, updateMemoryKey, logToDashboard) => { ... }"
}
`;

    try {
      logToDashboard('AI', `Kod Üretiliyor (Deneme ${attempt}/${retries})...`);
      const result = await model.generateContent(systemPrompt);
      const cleanJson = result.response.text().replace(/```json|```/g, '').trim();
      const decision = JSON.parse(cleanJson);

      if (attempt === 1 && decision.chatReply && bot) {
        bot.chat(decision.chatReply);
        logToDashboard('BOT_CHAT', decision.chatReply);
      }

      if (decision.code && bot) {
        previousCode = decision.code;
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const dynamicFn = new AsyncFunction('bot', 'mcData', 'goals', 'updateMemoryKey', 'logToDashboard', decision.code);

        await dynamicFn(bot, mcData, goals, updateMemoryKey, logToDashboard);
        logToDashboard('SUCCESS', 'Görev tamamlandı.');
        return;
      }
    } catch (err) {
      lastError = err.message;
      logToDashboard('WARNING', `Deneme ${attempt} Hatası: ${err.message}`);
      if (attempt === retries) {
        logToDashboard('ERROR', 'Kod hatası giderilemedi.');
        if (bot) bot.chat("Görevi kod hatası nedeniyle tamamlayamadım.");
      }
    }
  }
}

// --- Socket.IO Event Dinleyicileri ---
setInterval(broadcastStatus, 2000);

io.on('connection', (socket) => {
  socket.on('start_bot', (config) => {
    logToDashboard('SYSTEM', 'Yeni bağlantı isteği alındı.');
    initBot(config);
  });

  socket.on('disconnect_bot', () => {
    if (bot) {
      bot.quit();
      bot = null;
      currentConfig = null;
      logToDashboard('SYSTEM', 'Bot sunucudan çıkarıldı.');
    }
  });

  // Terminalden Oyuna / Sunucuya Doğrudan Komut veya Mesaj Gönderme
  socket.on('send_terminal_chat', (data) => {
    if (bot && data.message) {
      bot.chat(data.message);
      logToDashboard('TERMINAL_SENT', `[SİZ] ${data.message}`);
    } else {
      logToDashboard('ERROR', 'Bot sunucuda aktif değil, mesaj gönderilemedi.');
    }
  });

  socket.on('send_command', (data) => processRequestWithSelfCorrection(data.command, 'DashboardUser'));
  
  socket.on('stop_all', () => {
    if (bot && bot.pathfinder) bot.pathfinder.setGoal(null);
    logToDashboard('SYSTEM', 'Tüm hareketler durduruldu.');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=== Dashboard Çalışıyor: http://localhost:${PORT} ===`);
});
