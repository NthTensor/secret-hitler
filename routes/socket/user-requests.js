const Account = require('../../models/account');
const ModAction = require('../../models/modAction');
const PlayerReport = require('../../models/playerReport');
const Game = require('../../models/game');
const Signups = require('../../models/signups');

const {
	games,
	userList,
	genChat,
	isStandardAEM,
	userListEmitter,
	formattedUserList,
	gameListEmitter,
	formattedGameList
} = require('./models');
const { getProfile } = require('../../models/profile/utils');
const { sendInProgressGameUpdate } = require('./util');
const version = require('../../version');
const { obfIP } = require('./ip-obf');
const { CURRENTSEASONNUMBER } = require('../../src/frontend-scripts/node-constants');

/**
 * @param {object} socket - user socket reference.
 */
module.exports.sendUserList = socket => {
	// eslint-disable-line one-var
	if (socket) {
		socket.emit('fetchUser');
		// socket.emit('userList', {
		// 	list: formattedUserList()
		// });
	} else {
		userListEmitter.send = true;
	}
};

module.exports.sendSpecificUserList = (socket, userKey) => {
	// eslint-disable-line one-var

	if (socket != null) {
		socket.emit('userList', {
			list: formattedUserList(userKey)
		});
	}
};

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
				accountCreationDisabled,
				ipbansNotEnforced,
				gameCreationDisabled,
				limitNewPlayers,
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
 * @param {array} games - list of all games
 * @param {object} socket - user socket reference.
 * @param {number} count - depth of modinfo requested.
 * @param {boolean} isTrial - true if the user is a trial mod.
 */
module.exports.sendModInfo = (games, socket, count, isTrial) => {
	const userNames = userList.map(user => user.userName);

	Account.find({ username: userNames, 'gameSettings.isPrivate': { $ne: true } })
		.then(users => {
			getModInfo(games, users, socket, {}, count, isTrial);
		})
		.catch(err => {
			console.log(err, 'err in sending mod info');
		});
};

/**
 * @param {object} socket - user socket reference.
 */
module.exports.sendUserGameSettings = socket => {
	const { passport } = socket.handshake.session;

	if (!passport || !passport.user) {
		return;
	}

	Account.findOne({ username: passport.user })
		.then(account => {
			socket.emit('gameSettings', account.gameSettings);

			const userListNames = userList.map(user => user.userName);

			getProfile(passport.user);
			if (!userListNames.includes(passport.user)) {
				const userListInfo = {
					userName: passport.user,                                       // user
					staffRole: account.staffRole || '',                            // group
					isContributor: account.isContributor || false,                 // group
					staffDisableVisibleElo: account.gameSettings.staffDisableVisibleElo, // user
					staffDisableStaffColor: account.gameSettings.staffDisableStaffColor, // user
					staffIncognito: account.gameSettings.staffIncognito,           // user
					wins: account.wins,
					losses: account.losses,
					rainbowWins: account.rainbowWins,
					rainbowLosses: account.rainbowLosses,
					isPrivate: account.gameSettings.isPrivate,
					tournyWins: account.gameSettings.tournyWins,
					blacklist: account.gameSettings.blacklist,
					customCardback: account.gameSettings.customCardback,
					customCardbackUid: account.gameSettings.customCardbackUid,
					previousSeasonAward: account.gameSettings.previousSeasonAward,
					specialTournamentStatus: account.gameSettings.specialTournamentStatus,
					eloOverall: account.eloOverall,
					eloSeason: account.eloSeason,
					status: {
						type: 'none',
						gameId: null
					}
				};

				userListInfo[`winsSeason${CURRENTSEASONNUMBER}`] = account[`winsSeason${CURRENTSEASONNUMBER}`];
				userListInfo[`lossesSeason${CURRENTSEASONNUMBER}`] = account[`lossesSeason${CURRENTSEASONNUMBER}`];
				userListInfo[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] = account[`rainbowWinsSeason${CURRENTSEASONNUMBER}`];
				userListInfo[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] = account[`rainbowLossesSeason${CURRENTSEASONNUMBER}`];
				userList.push(userListInfo);
				sendUserList();
			}

			getProfile(passport.user);

			socket.emit('version', {
				current: version,
				lastSeen: account.lastVersionSeen || 'none'
			});
		})
		.catch(err => {
			console.log(err);
		});
};

/**
 * @param {object} socket - user socket reference.
 * @param {string} uid - uid of game.
 */
module.exports.sendReplayGameChats = (socket, uid) => {
	Game.findOne({ uid }).then((game, err) => {
		if (err) {
			console.log(err, 'game err retrieving for replay');
		}

		if (game) {
			socket.emit('replayGameChats', game.chats);
		}
	});
};

/**
 * @param {object} socket - User socket reference
 * @param {string} userKey - A user cache key
 */
module.exports.sendGameList = async (socket, userKey) => {
	const canSeeUnlisted = await isStandardAEM(userKey);
	// eslint-disable-line one-var
	if (socket != null) {
		let gameList = await formattedGameList();
		gameList = gameList.filter(game => canSeeUnlisted || (game && !game.isUnlisted));
		socket.emit('gameList', gameList);
	} else {
		gameListEmitter.send = true;
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
	await genChat.get().then(genChat => {
		socket.emit('generalChats', genChat);
	});
};

/**
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {string} override - Type of user status to be displayed.
 */
const updateUserStatus = async (userKey, gameKey, override) => {
	const release = await userInfo.acquire(userKey);
	if (gameKey != null) {
		const game = await games.get(gameKey);
		await userInfo.set(userKey, 'status', {
			type:
				override && game && !game.general.unlisted
					? override
					: game
					? game.general.private
						? 'private'
						: !game.general.unlisted && game.general.rainbowgame
							? 'rainbow'
							: !game.general.unlisted
								? 'playing'
								: 'none'
					: 'none',
			gameId: game ? game.general.uid : false
		}).then(release);
	} else {
		await userInfo.delete(userKey, 'status').then(release);
	}
	sendUserList();
};

module.exports.updateUserStatus = updateUserStatus;

	/**
 * @param {object} socket - A user socket reference
 * @param {string} gameKey - A game cache key
 * @param {string} [userKey] - An optional user cache key
 */
module.exports.sendGameInfo = async (socket, gameKey, userKey) => {

	let game;
	if (userKey != null) {

		const releaseUser = await userInfo.acquire(userKey);
		const currentGame = await userInfo.get(userKey, 'currentGame');

		/* Do not allow a user to join more than one game */
		if (currentGame != null) {
			releaseUser();
			return
		} else {
			await userInfo.set(userKey, 'currentGame').then(releaseUser);
		}

		const releaseGame = await games.acquire(gameKey);
		game = await games.get(gameKey);
		if (game != null) {
			const player = game.publicPlayersState.find(player => player.userName === userKey);

			if (player) {
				player.leftGame = false;
				player.connected = true;
				socket.emit('updateSeatForUser', true);
				await updateUserStatus(userKey, gameKey);
			} else {
				await updateUserStatus(userKey, gameKey, 'observing');
			}
		} else {
			releaseGame();
			const game = await Game.findOne({ uid: gameKey });
			socket.emit('manualReplayRequest', game ? gameKey : '');
			return;
		}

		await games.set(gameKey, game).then(releaseGame);

	} else {
		game = await games.get(gameKey);
	}

	if (game !== null) {
		if (userKey != null) {
			const player = game.publicPlayersState.find(player => player.userName === userKey);

			if (player) {
				player.leftGame = false;
				player.connected = true;
				socket.emit('updateSeatForUser', true);
				updateUserStatus(userKey, gameKey);
			} else {
				updateUserStatus(userKey, gameKey, 'observing');
			}
		}

		socket.join(gameKey);
		sendInProgressGameUpdate(game);
		socket.emit('joinGameRedirect', game.general.uid);
	} else {
		Game.findOne({ uid: gameKey }).then((game, err) => {
			if (err) {
				console.log(err, 'game err retrieving for replay');
			}

			socket.emit('manualReplayRequest', game ? gameKey : '');
		});
	}
};
