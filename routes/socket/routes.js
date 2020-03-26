const {
	handleUpdatedTruncateGame,
	handleUpdatedReportGame,
	handleAddNewGame,
	handleAddNewGameChat,
	handleNewGeneralChat,
	handleUpdatedGameSettings,
	handleSocketDisconnect,
	handleUserLeaveGame,
	updateSeatedUser,
	handleUpdateWhitelist,
	handleAddNewClaim,
	handleModerationAction,
	handlePlayerReport,
	handlePlayerReportDismiss,
	handleUpdatedBio,
	handleUpdatedRemakeGame,
	handleSubscribeModChat,
	handleModPeekVotes,
	handleGameFreeze,
	handleHasSeenNewPlayerModal,
	handleFlappyEvent,
} = require('./user-events');
const {
	sendPlayerNotes,
	sendUserReports,
	sendGameInfo,
	sendUserGameSettings,
	sendModInfo,
	sendGameList,
	sendGeneralChats,
	sendUserList,
	sendSpecificUserList,
	sendReplayGameChats,
	sendSignups,
	sendAllSignups,
	sendPrivateSignups,
	updateUserStatus
} = require('./user-requests');
const { selectVoting, selectPresidentPolicy, selectChancellorPolicy, selectChancellorVoteOnVeto, selectPresidentVoteOnVeto } = require('./game/election');
const { selectChancellor } = require('./game/election-util');
const {
	selectSpecialElection,
	selectPartyMembershipInvestigate,
	selectPolicies,
	selectPlayerToExecute,
	selectPartyMembershipInvestigateReverse,
	selectOnePolicy,
	selectBurnCard
} = require('./game/policy-powers');
const { games, userInfo, emoteList, isStandardAEM, findIPBan } = require('./models');
const Account = require('../../models/account');
const { TOU_CHANGES } = require('../../src/frontend-scripts/node-constants.js');
const version = require('../../version');
const interval = require('interval-promise');

const gamesGarbageCollector = async () => {
	const currentTime = Date.now();

	for await (const {release, gameKey} of games.acquireEach(games.keys())) {
		const game = await games.get(gameKey);
		if (
			(game.general.timeStarted && game.general.timeStarted + 4200000 < currentTime) ||
			(game.general.timeCreated &&
				game.general.timeCreated + 600000 < currentTime &&
				game.general.private &&
				game.publicPlayersState.length < 5)
		) {
			await games.remove(gameKey);
		}
		release();
	}

	sendGameList();
};

const attemptAuthenticate = socket => {
	let user;
	try {
		user = socket.handshake.session.passport.user;
	} catch {
		user = null;
	}
	return user;
};

/**
 * Returns true if userKey is seated in gameKey; False otherwise.
 *
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @return {Promise<boolean>}
 */
const isCurrentGame = async (userKey, gameKey) => {
	if (userKey != null) {
		const seatedGameKey = await userInfo.get(userKey, 'currentGame');
		if (seatedGameKey != null) {
			return Boolean(seatedGameKey === gameKey);
		}
	}
	return false;
};

const logOutUser = async (socket, userKey) => {
	socket.emit('manualDisconnection');
	socket.disconnect(true);

	await groups.remove("online", userKey);
};

const parseVer = ver => {
	const vals = ver.split('.');
	vals.forEach((v, i) => (vals[i] = parseInt(v)));
	return vals;
};

const firstVerNew = (v1, v2) => {
	for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
		if (!v2[i]) return true;
		if (!v1[i] || isNaN(v1[i]) || v1[i] < v2[i]) return false;
		if (v1[i] > v2[i]) return true;
	}
	return true;
};

const checkRestriction = async (socket, userKey, account) => {
	if (account.touLastAgreed && account.touLastAgreed.length) {
		const changesSince = [];
		const myVer = parseVer(account.touLastAgreed);
		TOU_CHANGES.forEach(change => {
			if (!firstVerNew(myVer, parseVer(change.changeVer))) changesSince.push(change);
		});
		if (changesSince.length) {
			socket.emit('touChange', changesSince);
			await groups.add('restricted', userKey);
		}
	} else {
		socket.emit('touChange', [TOU_CHANGES[TOU_CHANGES.length - 1]]);
		await groups.add('restricted', userKey);
	}
	const warnings = account.warnings.filter(warning => !warning.acknowledged);
	if (warnings.length > 0) {
		const { moderator, acknowledged, ...firstWarning } = warnings[0]; // eslint-disable-line no-unused-vars
		socket.emit('warningPopup', firstWarning);
		await groups.add('restricted', userKey);
	}
	// implement other restrictions as needed
	socket.emit('removeAllPopups');
	await groups.remove('restricted', userKey);
};

module.exports.socketRoutes = () => {
	interval(gamesGarbageCollector, 100000);

	io.on('connection', async socket => {
		console.log(process.pid, 'pid');

		const { passport } = socket.handshake.session;

		socket.emit('version', { current: version });

		/* validate games whenever a packet contains a gameKey */
		socket.use(async (packet, next) => {
			const data = packet[1];
			const gameKey = data && 'uid' in data;

			/* either send no gameKey or send one for an active game */
			if (!gameKey || await games.isActive(gameKey)) {
				return next();
			} else {
				socket.emit('gameUpdate', {});
			}
		});

		/* see if this session is authenciated as a user */
		const userKey = attemptAuthenticate(socket);

		/* If this socket is logged in as a user */
		if (userKey != null) {
			const account = await Account.findOne({ username: passport.user });
			const { sockets } = io.sockets;
			/* Try to find an old socket with the same user */
			const oldSocketID = Object.keys(sockets)
				.find(socketID =>
					sockets[socketID].handshake.session.passport &&
					Object.keys(sockets[socketID].handshake.session.passport).length &&
					sockets[socketID].handshake.session.passport.user === userKey &&
					socketID !== socket.id
				);

			/* Users can only open one socket at a time */
			if (oldSocketID && sockets[oldSocketID]) {
				sockets[oldSocketID].emit('manualDisconnection');
				delete sockets[oldSocketID];
			}

			/* If the user is in a game, set them back as connected */
			const gameKey = await userInfo.get(userKey, 'currentGame');
			if (gameKey !== null) {
				const release = await games.acquire(gameKey);
				const game = await games.get(gameKey);
				if (game.gameState.isStarted && !game.gameState.isCompleted) {
					game.publicPlayersState.find(player => player.userName === userKey).connected = true;
					games.set(gameKey, game).then(release);
					socket.join(game.general.uid);
					socket.emit('updateSeatForUser');
				}
			}

			/* Double-check the user isn't sneaking past IP bans. */
			const ipBans = await findIPBan(account.lastConnectedIP);
			if (account.isBanned
				|| (account.isTimeout && new Date() < account.isTimeout)
				|| (ipBans.isBanned && ipBans.type !== 'new' && !account.gameSettings.ignoreIPBans)) {
				await logOutUser(socket, userKey);
			}

			/* elevate permissions of compliant authenticated users */
			await checkRestriction(socket, userKey, account);
		}

		await sendGeneralChats(socket);
		await sendGameList(socket, userKey);

		/* Routing */

		socket.conn.on('upgrade', () => {
			sendUserList(socket);
			socket.emit('emoteList', emoteList);
		});

		socket.on('receiveRestrictions', async () => {
			if (userKey != null) {
				const account = await Account.findOne({ username: userKey });
				await checkRestriction(socket, userKey, account);
			}
		});

		socket.on('seeWarnings', async targetUser => {
			if (await isStandardAEM(userKey)) {
				await Account.findOne({ username: targetUser }).then(account => {
					if (account) {
						if (account.warnings && account.warnings.length > 0) {
							socket.emit('sendWarnings', { username: targetUser, warnings: account.warnings });
						} else {
							socket.emit('sendAlert', `That user doesn't have any warnings.`);
						}
					} else {
						socket.emit('sendAlert', `That user doesn't exist.`);
					}
				});
			} else {
				socket.emit('sendAlert', `Are you sure you're supposed to be doing that?`);
				console.log(userKey, 'tried to receive warnings for', targetUser);
			}
		});

		// user-events
		socket.on('disconnect', async () => {
			await handleSocketDisconnect(socket);
		});

		socket.on('sendUser', async () => {
			sendSpecificUserList(socket, userKey);
		});

		socket.on('flappyEvent', async data => {
			if (
				userKey != null
				&& 'uid' in data
				&& await groups.authorize(userKey, {none: ['restricted']})
				&& await isCurrentGame(userKey, data.uid)
			) {
				await handleFlappyEvent(data);
			}
		});

		socket.on('hasSeenNewPlayerModal', () => {
			if (userKey != null) {
				handleHasSeenNewPlayerModal(socket);
			}
		});

		socket.on('getSignups', () => {
			if (userKey != null && isStandardAEM(userKey)) {
				sendSignups(socket);
			}
		});

		socket.on('getAllSignups', () => {
			if (userKey != null && isStandardAEM(userKey)) {
				sendAllSignups(socket);
			}
		});

		socket.on('getPrivateSignups', () => {
			if (userKey != null && isStandardAEM(userKey)) {
				sendPrivateSignups(socket);
			}
		});

		socket.on('regatherAEMUsernames', () => {
			/* stub: removed for redis MVP */
		});

		socket.on('confirmTOU', async () => {
			if (
				userKey != null
				&& await groups.authorize(userKey, {none: ['restricted']})
			) {
				account = await Account.findOne({ username: userKey });
				account.touLastAgreed = TOU_CHANGES[0].changeVer;
				account.save();
				await checkRestriction(socket, userKey, account);
			}
		});

		socket.on('acknowledgeWarning', async () => {
			if (
				userKey != null
				&& await groups.authorize(userKey, {all: ['restricted']})
			) {
				Account.findOne({ username: userKey }).then(acc => {
					acc.warnings[acc.warnings.findIndex(warning => !warning.acknowledged)].acknowledged = true;
					acc.markModified('warnings');
					acc.save(() => checkRestriction(acc));
				});
			}
		});

		socket.on('handleUpdatedTheme', data => {
			/* removed for security concerns */
		});

		socket.on('updateModAction', async data => {
			if (userKey != null && await isStandardAEM(userKey)) {
				await handleModerationAction(socket, passport, data, false);
			}
		});

		socket.on('addNewClaim', async data => {
			if (
				userKey != null
				&& 'uid' in data
				&& await isCurrentGame(userKey, data.uid)
			) {
				const release = await games.acquire(gameKey);
				await handleAddNewClaim(socket, userKey, data.uid, data).then(release);
			}
		});

		socket.on('updateGameWhitelist', async data => {
			if (
				userKey != null
				&& 'uid' in data
				&& await isCurrentGame(userKey, data.uid)
			) {
				const release = await games.acquire(gameKey);
				await handleUpdateWhitelist(userKey, data.uid, data).then(release);
			}
		});

		socket.on('updateTruncateGame', data => {
			handleUpdatedTruncateGame(data);
		});

		socket.on('addNewGameChat', async data => {
			if (
				userKey != null
				&& 'uid' in data
				&& await isCurrentGame(userKey, data.uid)
				&& await groups.authorize(userKey, {none: ['restricted']})
			) {
				const release = await games.acquire(gameKey);
				await handleAddNewGameChat(socket, userKey, data.uid, data).then(release);
			}
		});

		socket.on('updateReportGame', data => {
			try {
				handleUpdatedReportGame(socket, data);
			} catch (e) {
				console.log(e, 'err in player report');
			}
		});

		socket.on('addNewGame', async data => {
			if (
				userKey != null
				&& await groups.authorize(userKey, {none: ['restricted']})
			) {
				await handleAddNewGame(socket, userKey, data);
			}
		});

		socket.on('updateGameSettings', data => {
			if (userKey != null) {
				handleUpdatedGameSettings(socket, passport, data);
			}
		});

		socket.on('addNewGeneralChat', async data => {
			if (
				userKey != null
				&& data != null
				&& 'chat' in data
				&& await groups.authorize(userKey, {none: ['restricted']})
			) {
				await handleNewGeneralChat(socket, userKey, data);
			}
		});

		socket.on('leaveGame', async data => {
			socket.leave(data.uid);
			if (
				userKey != null
			  && 'uid' in data
				&& await isCurrentGame(userKey, data.uid)
			) {
				const release = await games.acquire(data.uid);
				await handleUserLeaveGame(socket, userKey, data.uid, data).then(release);
			}
		});

		socket.on('updateSeatedUser', async data => {
			if (
				userKey != null
				&& await isCurrentGame(userKey, data.uid)
				&& await groups.authorize(userKey, {none: ['restricted']})
			) {
				const release = await games.acquire(data.uid);
				await updateSeatedUser(socket, userKey, data.uid).then(release);
			}
		});

		socket.on('playerReport', async data => {
			if (
				userKey != null
				&& data != null
				&& 'comment' in data
				&& typeof data.comment == 'string'
				&& data.comment.length > 140
				&& 'uid' in data
				&& await isCurrentGame(userKey, data.uid)
			) {
				await handlePlayerReport(userKey, data.uid, data);
			}
		});

		socket.on('playerReportDismiss', async () => {
			if (
				userKey != null
				&& await isStandardAEM(userKey)
			) {
				handlePlayerReportDismiss();
			}
		});

		socket.on('updateRemake', async data => {

			if (
				userKey != null
				&& 'uid' in data
				&& await isCurrentGame(userKey, data.uid)
			) {
				const release = await games.acquire(gameKey);
				await handleUpdatedRemakeGame(socket, userKey, gameKey, data).then(release);
			}
		});

		socket.on('updateBio', data => {
			if (
				userKey != null
			) {
				handleUpdatedBio(socket, userKey, data);
			}
		});

		// user-requests

		socket.on('getPlayerNotes', data => {
			/* removed for redis mvp */
		});

		socket.on('getGameList', () => {
			sendGameList(socket);
		});

		socket.on('getGameInfo', uid => {
			sendGameInfo(socket, uid);
		});

		socket.on('getUserList', () => {
			sendUserList(socket);
		});

		socket.on('getGeneralChats', () => {
			sendGeneralChats(socket);
		});

		socket.on('getUserGameSettings', () => {
			sendUserGameSettings(socket);
		});

		socket.on('selectedChancellorVoteOnVeto', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectChancellorVoteOnVeto(passport, game, data);
			}
		});

		socket.on('getModInfo', count => {
			if (authenticated && (isAEM || isTrial)) {
				sendModInfo(games, socket, count, isTrial && !isAEM);
			}
		});

		socket.on('subscribeModChat', uid => {
			if (authenticated && isAEM) {
				const game = findGame({ uid });
				if (game && game.private && game.private.seatedPlayers) {
					const players = game.private.seatedPlayers.map(player => player.userName);
					Account.find({ staffRole: { $exists: true, $ne: 'veteran' } }).then(accounts => {
						const staff = accounts
							.filter(acc => {
								acc.staffRole && acc.staffRole.length > 0 && players.includes(acc.username);
							})
							.map(acc => acc.username);
						if (staff.length) {
							socket.emit('sendAlert', `AEM members are present: ${JSON.stringify(staff)}`);
							return;
						}
						handleSubscribeModChat(socket, passport, game);
					});
				} else socket.emit('sendAlert', 'Game is missing.');
			}
		});

		socket.on('modPeekVotes', data => {
			const uid = data.uid;
			if (authenticated && isAEM) {
				const game = findGame({ uid });
				if (game && game.private && game.private.seatedPlayers) {
					handleModPeekVotes(socket, passport, game, data.modName);
				}
			} else {
				socket.emit('sendAlert', 'Game is missing.');
			}
		});

		socket.on('modFreezeGame', data => {
			const uid = data.uid;
			if (authenticated && isAEM) {
				const game = findGame({ uid });
				if (game && game.private && game.private.seatedPlayers) {
					handleGameFreeze(socket, passport, game, data.modName);
				}
			} else {
				socket.emit('sendAlert', 'Game is missing.');
			}
		});

		socket.on('getUserReports', () => {
			if (authenticated && (isAEM || isTrial)) {
				sendUserReports(socket);
			}
		});

		socket.on('updateUserStatus', async (type, gameId) => {
			if (userKey !== null && isCurrentGame(userKey, gameId)) {
				await updateUserStatus(userKey, game);
			} else if (userKey !== null ) {
				await updateUserStatus(userKey);
			}
		});

		socket.on('getReplayGameChats', uid => {
			sendReplayGameChats(socket, uid);
		});

		// election

		socket.on('presidentSelectedChancellor', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectChancellor(socket, passport, game, data);
			}
		});
		socket.on('selectedVoting', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectVoting(passport, game, data, socket);
			}
		});
		socket.on('selectedPresidentPolicy', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectPresidentPolicy(passport, game, data, false, socket);
			}
		});
		socket.on('selectedChancellorPolicy', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectChancellorPolicy(passport, game, data, false, socket);
			}
		});
		socket.on('selectedPresidentVoteOnVeto', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectPresidentVoteOnVeto(passport, game, data, socket);
			}
		});
		// policy-powers
		socket.on('selectPartyMembershipInvestigate', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectPartyMembershipInvestigate(passport, game, data, socket);
			}
		});
		socket.on('selectPartyMembershipInvestigateReverse', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectPartyMembershipInvestigateReverse(passport, game, data, socket);
			}
		});
		socket.on('selectedPolicies', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				if (game.private.lock.policyPeekAndDrop) selectOnePolicy(passport, game);
				else selectPolicies(passport, game, socket);
			}
		});
		socket.on('selectedPresidentVoteOnBurn', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectBurnCard(passport, game, data, socket);
			}
		});
		socket.on('selectedPlayerToExecute', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectPlayerToExecute(passport, game, data, socket);
			}
		});
		socket.on('selectedSpecialElection', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				selectSpecialElection(passport, game, data, socket);
			}
		});
	});
};