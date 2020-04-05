const Account = require('../../models/account');
const ModAction = require('../../models/modAction');
const PlayerReport = require('../../models/playerReport');
const Game = require('../../models/game');
const Signups = require('../../models/signups');
const {
	games,
	userInfo,
	genChat,
	gameSets,
	isStandardAEM,
} = require('./models');
const { obfIP } = require('./ip-obf');
const { CURRENTSEASONNUMBER } = require('../../src/frontend-scripts/node-constants');

const getModInfo = (games, users, socket, queryObj, count = 1, isTrial) => {
	const maskEmail = email => (email && email.split('@')[1]) || '';
	ModAction.find(queryObj)
		.sort({ $natural: -1 })
		.limit(500 * count)
		.then(actions => {
			const list = users.map(user => ({
				status: userList.find(userListUser => user.username === userListUser.userName).status,
				isRainbow: user.wins + user.losses > 49,
				userName: user.username,
				ip: user.lastConnectedIP || user.signupIP,
				email: `${user.verified ? '+' : '-'}${maskEmail(user.verification.email)}`
			}));
			list.forEach(user => {
				if (user.ip && user.ip != '') {
					try {
						user.ip = '-' + obfIP(user.ip);
					} catch (e) {
						user.ip = 'ERROR';
						console.log(e);
					}
				}
			});
			actions.forEach(action => {
				if (action.ip && action.ip != '') {
					if (action.ip.startsWith('-')) {
						action.ip = 'ERROR'; // There are some bugged IPs in the list right now, need to suppress it.
					} else {
						try {
							action.ip = '-' + obfIP(action.ip);
						} catch (e) {
							action.ip = 'ERROR';
							console.log(e);
						}
					}
				}
			});
			const gList = [];
			if (games) {
				Object.values(games).forEach(game => {
					gList.push({
						name: game.general.name,
						uid: game.general.uid,
						electionNum: game.general.electionCount,
						casual: game.general.casualGame,
						private: game.general.private,
						custom: game.customGameSettings.enabled,
						unlisted: game.general.unlisted
					});
				});
			}
			socket.emit('modInfo', {
				modReports: actions,
				userList: list,
				gameList: gList,
				hideActions: isTrial || undefined
			});
		})
		.catch(err => {
			console.log(err, 'err in finding mod actions');
		});
};

module.exports.getModInfo = getModInfo;

module.exports.sendSignups = socket => {
	Signups.find({ type: { $in: ['local', 'discord', 'github'] } })
		.sort({ $natural: -1 })
		.limit(500)
		.then(signups => {
			socket.emit('signupsInfo', signups);
		})
		.catch(err => {
			console.log(err, 'err in finding signups');
		});
};

module.exports.sendAllSignups = socket => {
	Signups.find({ type: { $nin: ['local', 'private', 'discord', 'github'] } })
		.sort({ $natural: -1 })
		.limit(500)
		.then(signups => {
			socket.emit('signupsInfo', signups);
		})
		.catch(err => {
			console.log(err, 'err in finding signups');
		});
};

module.exports.sendPrivateSignups = socket => {
	Signups.find({ type: 'private' })
		.sort({ $natural: -1 })
		.limit(500)
		.then(signups => {
			socket.emit('signupsInfo', signups);
		})
		.catch(err => {
			console.log(err, 'err in finding signups');
		});
};

/**
 *
 * @param {Object} socket - Socket reference
 * @param {string} userKey - A user cache key
 * @param {number} count - Depth of modinfo requested
 */
module.exports.sendModInfo = async (socket, userKey, count) => {
	const isTrail = await groups.isMember('trailmod', userKey);
	const userKeys = await groups.members('online');
	Account.find({ username: userKeys, 'gameSettings.isPrivate': { $ne: true } })
		.then(users => {
			getModInfo(games, users, socket, {}, count, isTrail);
		})
		.catch(err => {
			console.log(err, 'err in sending mod info');
		});
};

/**
 * @param {object} socket - Socket reference
 * @param {string} userKey - A user cache key
 */
module.exports.sendUserGameSettings = (socket, userKey) => {
	Account.findOne({ username: userKey })
		.then(account => {
			socket.emit('gameSettings', account.gameSettings);
		})
		.catch(err => {
			console.log(err);
		});
};

/**
 * @param {object} socket - user socket reference.
 * @param {string} gameKey - uid of game.
 */
module.exports.sendReplayGameChats = async (socket, gameKey) => {
	const game = await Game.findOne({ uid: gameKey });

	if (game) {
		socket.emit('replayGameChats', await games.readChannels(gameKey ,'publicGameChat'));
	}
};

/**
 * @param {object} socket - user socket reference.
 */
module.exports.sendUserReports = socket => {
	PlayerReport.find()
		.sort({ $natural: -1 })
		.limit(500)
		.then(reports => {
			socket.emit('reportInfo', reports);
		});
};

/**
 * @param {object} socket - user socket reference.
 */
module.exports.sendGeneralChats = async socket => {
	const history = await genChat.get();
	socket.emit('generalChats', history);
};

/**
 * Adds a user to a game lobby.
 *
 * @param {object} socket - A user socket reference
 * @param {string} gameKey - A game cache key
 * @param {string} [userKey] - An optional user cache key
 */
module.exports.joinGameLobby = async (socket, gameKey, userKey) => {

	if (userKey != null) {
		/* If logged in as a user */

		const release = await userInfo.acquire(userKey).writeLock();
		try {
			const { currentGame } = await userInfo.get(userKey, 'currentGame');

			/* Do not allow a user to join more than one game */
			if (currentGame == null) {

				if (await gameSets.isMember('active', gameKey)) {
					/* If the game is active, add the user to the game lobby */
					socket.join(gameKey);
					socket.emit('joinGameRedirect', gameKey);
					await userInfo.set(userKey, 'currentGame', gameKey);
					await groups.add('present', userKey, gameKey);

					if (await groups.isMember('players', userKey, gameKey)) {
						/* If the user is a player,
						 * then we should update their status to reflect that.
						 */
						socket.emit('updateSeatForUser', true);
					}
				} else {
					/* The game is not active, so load a replay */
					const game = await Game.findOne({ uid: currentGame });
					socket.emit('manualReplayRequest', game ? currentGame : '');
				}

			}
		} catch (e) {
			console.error(e);
		} finally {
			release();
		}
	}
};
