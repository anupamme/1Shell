'use strict';

const http = require('http');
const { Server } = require('socket.io');

function createServer(app) {
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: false },
    maxHttpBufferSize: 16 * 1024 * 1024,
  });

  return { io, server };
}

module.exports = {
  createServer,
};
