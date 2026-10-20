const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Хранилище данных онлайн-сессии
const onlinePlayers = {}; // playerId -> { id, nickname, level, networth, socketId, status }
let sharedAuctionLots = []; // Общие лоты от реальных игроков

io.on('connection', (socket) => {
  console.log('Подключился сокет:', socket.id);

  // 1. Регистрация / обновление данных игрока
  socket.on('player_sync', (data) => {
    if (!data || !data.playerId) return;
    socket.playerId = data.playerId;

    onlinePlayers[data.playerId] = {
      id: data.playerId,
      name: data.nickname || `Игрок_${data.playerId}`,
      lvl: data.level || 1,
      nw: data.networth || 0,
      status: 'Онлайн · В игре',
      socketId: socket.id
    };

    // Рассылаем всем актуальный список онлайн-игроков и список Forbes
    io.emit('online_players_update', Object.values(onlinePlayers));
    socket.emit('shared_auction_sync', sharedAuctionLots);
  });

  // 2. Оповещение на весь сервер, когда кто-то выбил редкий номер (Мифический / Секретный)
  socket.on('rare_plate_drop', ({ nickname, plateStr, price, rarityName }) => {
    io.emit('server_broadcast', `🔥 Игрок ${nickname} только что выбил ${rarityName} номер [${plateStr}] за ${price}!`);
  });

  // 3. Выставление номера реального игрока на общий Аукцион
  socket.on('auction_list_lot', (lotData) => {
    // lotData: { uid, plate, askPrice, minBid, sellerName, sellerId }
    sharedAuctionLots.unshift(lotData);
    if (sharedAuctionLots.length > 30) sharedAuctionLots.pop();
    io.emit('shared_auction_sync', sharedAuctionLots);
    io.emit('server_broadcast', `🔨 ${lotData.sellerName} выставил на аукцион номер [${lotData.plateStr}] за ${lotData.askPrice.toLocaleString('ru-RU')} ₽!`);
  });

  // 4. Покупка лота на Аукционе другим реальным игроком
  socket.on('auction_buy_lot', ({ lotUid, buyerId, buyerName, paidPrice }) => {
    const idx = sharedAuctionLots.findIndex(x => x.uid === lotUid);
    if (idx === -1) return;

    const soldLot = sharedAuctionLots.splice(idx, 1)[0];
    io.emit('shared_auction_sync', sharedAuctionLots);

    // Отправляем деньги продавцу, если он онлайн
    const seller = onlinePlayers[soldLot.sellerId];
    if (seller && seller.socketId) {
      io.to(seller.socketId).emit('your_auction_lot_sold', {
        uid: soldLot.uid,
        plateStr: soldLot.plateStr,
        paidPrice,
        buyerName
      });
    }
  });

  // 5. Прямая P2P-торговля с живым игроком по его ID
  socket.on('p2p_trade_offer', ({ targetId, fromId, fromName, plate, askPrice, markupPct }) => {
    const target = onlinePlayers[targetId];
    if (!target || !target.socketId) {
      socket.emit('p2p_trade_result', { success: false, msg: `Игрок с ID ${targetId} сейчас не в сети (сделка обработана ботом).` });
      return;
    }
    io.to(target.socketId).emit('p2p_incoming_offer', {
      fromId,
      fromName,
      plate,
      askPrice,
      markupPct
    });
  });

  // Ответ покупателя на P2P-предложение
  socket.on('p2p_trade_accept', ({ sellerId, buyerId, buyerName, plate, price }) => {
    const seller = onlinePlayers[sellerId];
    if (seller && seller.socketId) {
      io.to(seller.socketId).emit('p2p_offer_accepted_by_buyer', {
        buyerId,
        buyerName,
        plateUid: plate.uid,
        plateStr: `${plate.l1}${plate.digits}${plate.l2}${plate.l3} ${plate.regionCode}`,
        price
      });
    }
  });

  // 6. Приглашение реального игрока в Клан по ID
  socket.on('clan_invite_send', ({ targetId, fromName, clanTag, clanName }) => {
    const target = onlinePlayers[targetId];
    if (target && target.socketId) {
      io.to(target.socketId).emit('clan_invite_received', { fromName, clanTag, clanName });
    }
  });

  // Отключение игрока
  socket.on('disconnect', () => {
    if (socket.playerId && onlinePlayers[socket.playerId]) {
      delete onlinePlayers[socket.playerId];
      io.emit('online_players_update', Object.values(onlinePlayers));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚔 Онлайн-сервер ГОСНОМЕР: ИМПЕРИЯ запущен!`);
  console.log(`👉 Откройте в браузере: http://localhost:${PORT}`);
  console.log(`====================================================`);
});