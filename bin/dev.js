'use strict';

const cluster = require('cluster');
const debug = require('debug')('app:server');

if (cluster.isMaster) {
	const net = require('net');
	const farmhash = require('farmhash');
	const coreCount = require('os').cpus().length;

	/* Distributes an IP to a number of workers using a really fast hash. */
	const worker_index = function(ip, len) {
		return farmhash.fingerprint32(ip) % len;
	};

	let workers = [];

	/* Spawns a worker process that will auto-restart. */
	const spawn = function(i) {
		workers[i] = cluster.fork();

		workers[i].on('exit', function(code, signal) {
			console.log('respawning worker', i);
			spawn(i);
		});
	};

	for (let i = 0; i < coreCount; i++) {
		spawn(i);
	}

	const port = (() => {
		const val = process.env.PORT || '8080';
		const port = parseInt(val, 10);

		if (isNaN(port)) {
			return val;
		}

		if (port >= 0) {
			return port;
		}

		return false;
	})();

	/* Proxy socket.io connections through to workers. */
	const server = net
		.createServer({ pauseOnConnect: true }, function(connection) {
			/* We received a connection and need to pass it to the appropriate
			 * worker. Get the worker for this connection's source IP and pass
			 * it the connection.
			 */
			const worker = workers[worker_index(connection.remoteAddress, coreCount)];
			worker.send('sticky-session:connection', connection);
		})
		.listen(port);

	function onError(error) {
		if (error.syscall !== 'listen') {
			throw error;
		}

		const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;

		switch (error.code) {
			case 'EACCES':
				console.error(bind + ' requires elevated privileges');
				process.exit(1);
				break;
			case 'EADDRINUSE':
				console.error(bind + ' is already in use');
				process.exit(1);
				break;
			default:
				throw error;
		}
	}

	function onListening() {
		const addr = server.address();
		const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
		debug('Listening on ' + bind);
		console.log('Listening on ' + bind);
	}

	server.on('error', onError);
	server.on('listening', onListening);

	/* Now do nothing.
	 * Anything else increases the chances of crashing the master thread.
	 */
} else {
	const http = require('http');
	const express = require('express');
	const socket_redis = require('socket.io-redis');

	require('dotenv').config();

	global.app = express();

	const server = http.createServer(app);

	global.redis = require('redis').createClient();
	global.io = require('socket.io')(server);
	global.notify = require('node-notifier');

	app.set('strict routing', true);

	/* Dont expose our server publicly,
	 * We expose the master process and it will route for the children. */
	server.listen(0, 'localhost');

	/* Enable socket.io redis */
	io.adapter(socket_redis({ host: 'localhost', port: 6379 }));

	/* Listen to messages sent from the master. */
	process.on('message', function(message, connection) {
		if (message !== 'sticky-session:connection') {
			return;
		}

		/* Emulate a connection event on the server by emitting the
		 * event with the connection the master sent us.
		 */
		server.emit('connection', connection);
		connection.resume();
	});

	/* Once the server is up, start the application logic */
	function onListening() {
		require('../app');
	}

	server.on('listening', onListening);
}
