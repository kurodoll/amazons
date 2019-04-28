const express = require('express');
const path = require('path');

const app = require('express')();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
  'pingInterval': 2000,
  'pingTimeout': 5000 });

app.use(express.static(path.join(__dirname, 'public')));

// Local JavaScripts
const game_logic = require(path.join(__dirname, 'public/js/game_logic'));

const Client  = require(path.join(__dirname, 'public/js/client'));
const Board   = require(path.join(__dirname, 'public/js/board'));
const Amazons = require(path.join(__dirname, 'public/js/amazons'));
const AI      = new (require(path.join(__dirname, 'public/js/ai')))(game_logic);

let config;
try {
  config = require(path.join(__dirname, 'config'));
} catch (e) {
  console.warn('No config file found.');
}


// ========================================================================= //
// *                                                                DB Init //
// ========================================================================//
const pg  = require('pg');
const url = require('url');

let db_url;
let pg_pool;

if (process.env.DATABASE_URL) {
  db_url = process.env.DATABASE_URL;
} else {
  db_url = config.db.url;
}

if (db_url) {
  const params = url.parse(db_url);
  const auth = params.auth.split(':');

  const pg_config = {
    host: params.hostname,
    port: params.port,
    user: auth[0],
    password: auth[1],
    database: params.pathname.split('/')[1],
    ssl: true,
    max: 10,
    idleTimeoutMillis: 30000 };

  pg_pool = new pg.Pool(pg_config);
} else {
  console.error('Couldn\'t connect to database as no config could be loaded.');
}

pg_pool.on('error', function(err, client) {
  console.error('Idle client error: ', err.message, err.stack);
});


// ========================================================================= //
// *                                                                Routing //
// ========================================================================//
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/index.html'));
});


// ========================================================================= //
// *                                           Game Server Global Variables //
// ========================================================================//
const clients       = {};
const match_invites = {};
const matches       = {};


// ========================================================================= //
// *                                                              Socket.io //
// ========================================================================//
io.on('connection', (socket) => {
  const client = new Client(genID(), socket);
  clients[client.id] = client;

  log(
      'socket.io',
      'A client has connected',
      { client_id: client.id, users_online: Object.keys(clients).length });

  // Send client their ID
  socket.emit('id', client.id);

  // User has chosen a username
  socket.on('set_username', (username) => {
    if (username.length >= 3 && username.length <= 20) {
      // Save username to DB or get saved ID
      let query = 'SELECT * FROM users WHERE username = $1;';
      let vars  = [ username ];

      pg_pool.query(query, vars, (err, result) => {
        if (err) {
          console.error(err);
          socket.emit('logged_in');
        } else if (result.rows.length == 0) {
          query = 'INSERT INTO users (username, user_id) VALUES ($1, $2);';
          vars  = [ username, client.id ];

          pg_pool.query(query, vars, (err2, result2) => {
            if (err2) {
              console.error(err2);
            }

            socket.emit('logged_in');
          });
        } else {
          const old_id = client.id;
          client.changeID(result.rows[0].user_id);
          clients[client.id] = client;
          delete clients[old_id];

          socket.emit('id', client.id);
          socket.emit('logged_in');
        }
      });

      client.setUsername(username);
      socket.emit('username_set', username);

      log(
          'socket.io',
          'Client has set username',
          { client_id: client.id, username: username });

      // Broadcast the list of users to all clients,
      // so that everybody has a live list of all online users
      const users_info =
        Object.keys(clients)
            .filter((c) => {
              return clients[c].username;
            })
            .map((c) => {
              return {
                id:       clients[c].id,
                username: clients[c].username };
            });

      io.emit('users_list', users_info);
    } else {
      socket.emit(
          'error_message',
          'Username must be 3 to 20 characters long (inclusive)');

      log(
          'socket.io',
          'Client has attempted to set an invalid username',
          { client_id: client.id, username: username });
    }
  });


  // -------------------------------------------------------------- Match Setup
  // User has invited a player to a match
  socket.on('player_invite', (player_id) => {
    if (!client.ready()) {
      return;
    }

    const match_invite_id = genID('matchinvite');

    if (clients[player_id]) {
      clients[player_id].socket.emit('match_invite', {
        from:            client.username,
        match_invite_id: match_invite_id });

      socket.emit('set_invite_id', {
        player:          player_id,
        match_invite_id: match_invite_id });
    }

    match_invites[match_invite_id] = {
      from: client.id,
      to:   player_id };

    log('socket.io', 'Match invite sent', {
      id:   match_invite_id,
      from: client.id,
      to:   player_id });
  });

  socket.on('match_accept', (match_invite_id) => {
    // Check whether the requester is still around
    if (!clients[match_invites[match_invite_id].from]) {
      return;
    }

    clients[match_invites[match_invite_id].from].socket.emit(
        'invite_response',
        {
          player_id:       match_invites[match_invite_id].to,
          match_invite_id: match_invite_id,
          response:        'accepted' });

    log('socket.io', 'Match invite accepted', {
      id:   match_invite_id,
      from: match_invites[match_invite_id].from,
      to:   match_invites[match_invite_id].to });

    delete match_invites[match_invite_id];
  });

  socket.on('match_decline', (match_invite_id) => {
    // Check whether the requester is still around
    if (!clients[match_invites[match_invite_id].from]) {
      return;
    }

    clients[match_invites[match_invite_id].from].socket.emit(
        'invite_response',
        {
          player_id: match_invites[match_invite_id].to,
          match_invite_id: match_invite_id,
          response: 'declined' });

    log('socket.io', 'Match invite declined', {
      id:   match_invite_id,
      from: match_invites[match_invite_id].from,
      to:   match_invites[match_invite_id].to });

    delete match_invites[match_invite_id];
  });

  socket.on('match_start', (settings) => {
    // Make sure the match is valid
    let   n_players    = 0;
    const players_real = [];

    for (let i = 0; i < settings.players.length; i++) {
      if (settings.players[i].accepted == 'accepted') {
        // If the player is a bot, give them a unique ID
        if (settings.players[i].type == 'bot') {
          settings.players[i].id = genID(settings.players[i].id);
        }

        n_players += 1;
        players_real.push(settings.players[i]);
      }
    }

    const pieces = JSON.parse(settings.piece_config);
    let   correct_players = 0;

    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].owner > correct_players) {
        correct_players = pieces[i].owner;
      }
    }

    if (n_players != correct_players + 1) {
      return;
    }

    // Initialize the match data
    const match_id = genID('match');

    const board = new Board(parseInt(settings.board_size), pieces);

    const game = new Amazons(
        match_id,
        players_real,
        board,
        parseInt(settings.turn_timer),
        game_logic,
        AI
    );

    matches[match_id] = game;

    // Set players
    for (let i = 0; i < n_players; i++) {
      game.setPlayer(players_real[i].id, i);
      game.setPlayer(players_real[i].id, i);
    }

    log('socket.io', 'Match begun', { id: match_id });
    game.begin(clients);
    game.emitBoard(clients);
  });


  // -------------------------------------------------------- Match Interaction
  socket.on('attempt_move', (data) => {
    if (!matches[data.match_id]) {
      // Invalid match ID
      return;
    }

    const board = matches[data.match_id].board.board;
    const miid  = matches[data.match_id].getInternalId(client.id);

    // Ensure that the move is valid
    if (board[data.from.x][data.from.y].owner == miid &&
        matches[data.match_id].turn == miid) {
      if (matches[data.match_id].attemptMove(data.from, data.to)) {
        socket.emit('move_success', data.to);
        matches[data.match_id].emitBoard(clients);
      }
    }
  });

  socket.on('attempt_burn', (data) => {
    if (!matches[data.match_id]) {
      // Invalid match ID
      return;
    }

    const miid  = matches[data.match_id].getInternalId(client.id);

    // Ensure that the move is valid
    if (matches[data.match_id].turn == miid) {
      if (matches[data.match_id].attemptBurn(data.tile)) {
        socket.emit('burn_success');
        matches[data.match_id].emitBoard(clients);
      }
    }
  });


  // ------------------------------------------------------------------ Cleanup
  socket.on('disconnect', () => {
    delete clients[client.id];
    log('socket.io', 'A client has disconnected', { client_id: client.id });

    // Broadcast the list of users to all clients,
    // so that everybody has a live list of all online users
    const users_info =
      Object.keys(clients)
          .filter((c) => {
            return clients[c].username;
          })
          .map((c) => {
            return {
              id:       clients[c].id,
              username: clients[c].username };
          });

    io.emit('users_list', users_info);
  });
});


http.listen(process.env.PORT || 3000, () => {
  console.log('listening on *:' + (process.env.PORT || 3000));
});


// ========================================================================= //
// *                                                       Helper Functions //
// ========================================================================//
function genID(type=null) {
  if (type) {
    return type + '_' + Math.random().toString(36).substr(2, 9);
  } else {
    return '_' + Math.random().toString(36).substr(2, 9);
  }
}

function log(caller, message, data) {
  const time     = new Date();
  const time_str = time.toLocaleString();

  process.stdout.write(time_str + ' [' + caller + '] ' + message + ' ');
  console.dir(data);
}
