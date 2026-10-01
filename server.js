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

// --- Yapılandırma ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE";
const SERVER_HOST = process.env.MC_HOST || "localhost";
const SERVER_PORT = parseInt(process.env.MC_PORT || "25565");
const BOT_NAME = process.env.BOT_NAME || "DynamicGeminiBot";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK || "";
const MEMORY_FILE = path.join(__dirname, 'bot_memory.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let bot = null;
let mcData = null;

// --- Hafıza Yönetimi ---
function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ basePosition: null, waypoints: {}, playerRelations: {} }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (e) {
    return { basePosition: null, waypoints: {}, playerRelations: {} };
  }
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

// --- Dashboard & Discord Loglama ---
function logToDashboard(type, message) {
  console.log(`[${type}] ${message}`);
  io.emit('bot_log', { type, message, timestamp: new Date().toLocaleTimeString() });

  if (DISCORD_WEBHOOK_URL && ['ERROR', 'WARNING', 'SYSTEM'].includes(type)) {
    axios.post(DISCORD_WEBHOOK_URL, {
      content: `**[${type}]** ${message}`
    }).catch(() => {});
  }
}

function broadcastStatus() {
  if (!bot || !bot.entity) return;
  const status = {
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
function initBot() {
  logToDashboard('SYSTEM', 'Sunucuya bağlanılıyor...');
  
  bot = mineflayer.createBot({
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_NAME,
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

    // 3D Ekran Görünümü (Port: 3007)
    try {
      prismarineViewer(bot, { port: 3007, firstPerson: true });
      logToDashboard('SYSTEM', 'Canlı 3D Görünüm Port 3007 üzerinde aktif.');
    } catch (e) {
      logToDashboard('WARNING', `3D Ekran başlatılamadı: ${e.message}`);
    }

    // Otomatik Yemek Yeme Yapılandırması
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14,
      bannedFood: ['rotten_flesh', 'poisonous_potato', 'pufferfish']
    };

    logToDashboard('SYSTEM', `${bot.username} sunucuya başarıyla girdi.`);
  });

  // Otomatik Öz Savunma
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    const attacker = bot.nearestEntity(e => (e.type === 'mob' || e.type === 'player') && e.position.distanceTo(bot.entity.position) < 5);
    
    if (attacker) {
      logToDashboard('WARNING', `Saldırı tespit edildi! Hedef: ${attacker.name || attacker.username}`);
      const sword = bot.inventory.items().find(item => item.name.includes('sword'));
      if (sword) bot.equip(sword, 'hand');
      if (bot.pvp) {
        bot.pvp.attack(attacker);
      } else {
        bot.attack(attacker);
      }
    }
  });

  bot.on('kicked', (reason) => {
    logToDashboard('WARNING', `Sunucudan atıldı: ${reason}. 10 saniye sonra tekrar bağlanılacak...`);
    setTimeout(initBot, 10000);
  });

  bot.on('error', (err) => {
    logToDashboard('ERROR', `Bağlantı hatası: ${err.message}`);
  });

  bot.on('end', () => {
    logToDashboard('WARNING', 'Bağlantı koptu. 5 saniye sonra tekrar bağlanılıyor...');
    setTimeout(initBot, 5000);
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
  logToDashboard('AI', `Gelen İstek [${sender}]: "${userMessage}"`);

  let lastError = null;
  let previousCode = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const env = getEnvironmentContext();

    const systemPrompt = `
Sen Mineflayer altyapısında çalışan otonom bir Minecraft botusun.
Sana verilen isteği gerçekleştirmek için GERÇEK Node.js / Mineflayer KODU üret.

ANLIK DURUM:
- Konum: X:${env.position.x}, Y:${env.position.y}, Z:${env.position.z}
- Can: ${env.health}/20, Açlık: ${env.food}/20
- Envanter: ${env.inventory}
- Kalıcı Hafıza: ${env.memoryContext}

KULLANILABİLİR DEĞİŞKENLER:
- \`bot\`: Mineflayer bot örneği.
- \`mcData\`: minecraft-data nesnesi.
- \`goals\`: mineflayer-pathfinder goals.
- \`updateMemoryKey(key, value)\`: Hafızaya veri kaydetme fonksiyonu.
- \`logToDashboard(type, msg)\`: Log basma fonksiyonu.

${lastError ? `
 ÖNEMLİ (HATA DÜZELTME MODU):
Önceki denemede ürettiğin kod HATA verdi!
Hatalı Kod:
\`\`\`javascript
${previousCode}
\`\`\`
Hata Mesajı:
"${lastError}"

Lütfen hatayı analiz et ve bu hatayı giderecek DÜZELTİLMİŞ yeni kodu üret.
` : ''}

SADECE GEÇERLİ JSON DÖNDÜR:
{
  "thought": "Yapılacak mantıksal plan",
  "chatReply": "Oyuncuya verilecek kısa bilgi yanıtı",
  "code": "async (bot, mcData, goals, updateMemoryKey, logToDashboard) => { ... }"
}
`;

    try {
      logToDashboard('AI', `AI Kod Üretiyor (Deneme ${attempt}/${retries})...`);
      const result = await model.generateContent(systemPrompt);
      const responseText = result.response.text().trim();
      const cleanJson = responseText.replace(/```json|```/g, '').trim();
      const decision = JSON.parse(cleanJson);

      if (attempt === 1 && decision.chatReply) {
        bot.chat(decision.chatReply);
        logToDashboard('BOT_CHAT', decision.chatReply);
      }

      if (decision.thought) {
        logToDashboard('AI_THOUGHT', decision.thought);
      }

      if (decision.code) {
        previousCode = decision.code;
        logToDashboard('ACTION', 'Kod çalıştırılıyor...');

        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const dynamicFn = new AsyncFunction('bot', 'mcData', 'goals', 'updateMemoryKey', 'logToDashboard', decision.code);

        await dynamicFn(bot, mcData, goals, updateMemoryKey, logToDashboard);
        logToDashboard('SUCCESS', 'Görev başarıyla tamamlandı.');
        return;
      } else {
        return;
      }

    } catch (err) {
      lastError = err.message;
      logToDashboard('WARNING', `Deneme ${attempt} Hatası: ${err.message}`);
      
      if (attempt === retries) {
        logToDashboard('ERROR', 'Maksimum deneme sayısına ulaşıldı. Görev iptal edildi.');
        if (bot) bot.chat("Üzgünüm, bu görevi kod hatası nedeniyle tamamlayamadım.");
      }
    }
  }
}

// --- Sunucu ve Socket.IO Başlatma ---
setInterval(broadcastStatus, 2000);

io.on('connection', (socket) => {
  socket.on('send_command', (data) => processRequestWithSelfCorrection(data.command, 'DashboardUser'));
  socket.on('stop_all', () => {
    if (bot) bot.pathfinder.setGoal(null);
    logToDashboard('SYSTEM', 'Tüm hedefler durduruldu.');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=== Dashboard Aktif: http://localhost:${PORT} ===`);
  initBot();
});
