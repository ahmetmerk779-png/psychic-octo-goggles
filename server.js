const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const autoEat = require('mineflayer-auto-eat').plugin;
const { mineflayer: prismarineViewer } = require('prismarine-viewer');
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
let currentConfig = null; // Panelden gelen ayarlar burada tutulur

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

// --- Panelden Gelen Konfigürasyon ile Botu Başlatma ---
function initBot(config) {
  if (bot) {
    logToDashboard('SYSTEM', 'Mevcut bağlantı kapatılıyor...');
    bot.quit();
    bot = null;
  }

  currentConfig = config;

  // Gemini AI Modelini Panellerden Gelen API Key ile Başlat
  try {
    const genAI = new GoogleGenerativeAI(config.apiKey);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  } catch (e) {
    logToDashboard('ERROR', `Gemini API Başlatılamadı: ${e.message}`);
    return;
  }

  logToDashboard('SYSTEM', `${config.host}:${config.port} sunucusuna (${config.username}) olarak bağlanılıyor...`);

  bot = mineflayer.createBot({
    host: config.host,
    port: parseInt(config.port) || 25565,
    username: config.username || "DynamicBot",
    version: false
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(autoEat);

  bot.once('spawn', () => {
    mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    defaultMove.canDig = true;
    bot.pathfinder.setMovements(defaultMove);

    // 3D Ekran Görünümü
    try {
      prismarineViewer(bot, { port: 3007, firstPerson: true });
      logToDashboard('SYSTEM', 'Canlı 3D Görünüm aktif (Port 3007).');
    } catch (e) {
      logToDashboard('WARNING', `3D Ekran hatası: ${e.message}`);
    }

    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14,
      bannedFood: ['rotten_flesh', 'poisonous_potato', 'pufferfish']
    };

    logToDashboard('SYSTEM', `${bot.username} sunucuya başarıyla bağlandı!`);
  });

  // Otomatik Öz Savunma
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
    logToDashboard('WARNING', `Sunucudan atıldı: ${reason}. 10 saniye sonra tekrar bağlanılacak...`);
    setTimeout(() => { if (currentConfig) initBot(currentConfig); }, 10000);
  });

  bot.on('error', (err) => {
    logToDashboard('ERROR', `Bağlantı hatası: ${err.message}`);
  });

  bot.on('end', () => {
    logToDashboard('WARNING', 'Bağlantı koptu.');
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
    logToDashboard('ERROR', 'Gemini API henüz yapılandırılmadı!');
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
      logToDashboard('AI', `Kod Üretiyor (Deneme ${attempt}/${retries})...`);
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

// --- Socket.IO Event Bağlantıları ---
setInterval(broadcastStatus, 2000);

io.on('connection', (socket) => {
  // Panelden Sunucu Bilgileri Geldiğinde
  socket.on('start_bot', (config) => {
    logToDashboard('SYSTEM', 'Panelden yeni bağlantı isteği alındı.');
    initBot(config);
  });

  // Panelden Bağlantıyı Kes İsteği
  socket.on('disconnect_bot', () => {
    if (bot) {
      bot.quit();
      bot = null;
      currentConfig = null;
      logToDashboard('SYSTEM', 'Bot bağlantısı panel üzerinden kapatıldı.');
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
  console.log(`=== Dashboard Aktif: http://localhost:${PORT} ===`);
});
