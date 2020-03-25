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
	handleUpdatedPlayerNote,
	handleSubscribeModChat,
	handleModPeekVotes,
	handleGameFreeze,
	handleHasSeenNewPlayerModal,
	handleFlappyEvent,
	handleUpdatedTheme
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
const { games, userInfo, emoteList, findIPBan } = require('./models');
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

const isAuthenticated = socket => {
	if (socket.handshake && socket.handshake.session) {
		const { passport } = socket.handshake.session;

		return Boolean(passport && passport.user && Object.keys(passport).length);
	}
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

const checkRestriction = (socket, account) => {
	if (account.touLastAgreed && account.touLastAgreed.length) {
		const changesSince = [];
		const myVer = parseVer(account.touLastAgreed);
		TOU_CHANGES.forEach(change => {
			if (!firstVerNew(myVer, parseVer(change.changeVer))) changesSince.push(change);
		});
		if (changesSince.length) {
			socket.emit('touChange', changesSince);
			return true;
		}
	} else {
		socket.emit('touChange', [TOU_CHANGES[TOU_CHANGES.length - 1]]);
		return true;
	}
	const warnings = account.warnings.filter(warning => !warning.acknowledged);
	if (warnings.length > 0) {
		const { moderator, acknowledged, ...firstWarning } = warnings[0]; // eslint-disable-line no-unused-vars
		socket.emit('warningPopup', firstWarning);
		return true;
	}
	// implement other restrictions as needed
	socket.emit('removeAllPopups');
	return false;
};

module.exports.socketRoutes = () => {
	interval(gamesGarbageCollector, 100000);

	io.on('connection', async socket => {
		console.log(process.pid, 'pid');

		const { passport } = socket.handshake.session;

		socket.emit('version', { current: version });

		let isAEM = false;

		/* validate games whenever a packet contains a gameKey */
		socket.use(async (packet, next) => {
			const data = packet[1];
			const gameKey = data && data.uid;

			if (!gameKey || await games.isActive(gameKey)) {
				return next();
			} else {
				socket.emit('gameUpdate', {});
			}
		});

		/* all sessions start with restricted permissions */
		let isRestricted = true;

		const authenticated = isAuthenticated(socket);

		/* If this socket is logged in as a user */
		if (authenticated) {
			const userKey = passport.user;
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
			isRestricted = checkRestriction(socket, account);

			isAEM = await groups.authorize(userKey, {
				any: ['admin', 'editor', 'moderator'],
				none: ['trialmod', 'altmod', 'veteran']
			});
		}

		sendGeneralChats(socket);
		sendGameList(socket, isAEM);

		/* Routing */

		socket.conn.on('upgrade', () => {
			sendUserList(socket);
			socket.emit('emoteList', emoteList);
		});

		socket.on('receiveRestrictions', () => {
			Account.findOne({ username: passport.user }).then(account => {
				isRestricted = checkRestriction(account);
			});
		});

		socket.on('seeWarnings', username => {
			if (isAEM) {
				Account.findOne({ username: username }).then(account => {
					if (account) {
						if (account.warnings && account.warnings.length > 0) {
							socket.emit('sendWarnings', { username, warnings: account.warnings });
						} else {
							socket.emit('sendAlert', `That user doesn't have any warnings.`);
						}
					} else {
						socket.emit('sendAlert', `That user doesn't exist.`);
					}
				});
			} else {
				socket.emit('sendAlert', `Are you sure you're supposed to be doing that?`);
				console.log(passport.user, 'tried to receive warnings for', username);
			}
		});

		// user-events
		socket.on('disconnect', async () => {
			await handleSocketDisconnect(socket);
		});

		socket.on('sendUser', user => {
			sendSpecificUserList(socket, user.staffRole);
		});

		socket.on('flappyEvent', data => {
			if (isRestricted) return;
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				handleFlappyEvent(data, game);
			}
		});

		socket.on('hasSeenNewPlayerModal', () => {
			if (authenticated) {
				handleHasSeenNewPlayerModal(socket);
			}
		});

		socket.on('getSignups', () => {
			if (authenticated && isAEM) {
				sendSignups(socket);
			}
		});

		socket.on('getAllSignups', () => {
			if (authenticated && isAEM) {
				sendAllSignups(socket);
			}
		});

		socket.on('getPrivateSignups', () => {
			if (authenticated && isAEM) {
				sendPrivateSignups(socket);
			}
		});

		socket.on('regatherAEMUsernames', () => {
			if (authenticated && isAEM) {
				gatherStaffUsernames();
			}
		});

		socket.on('confirmTOU', () => {
			if (authenticated && isRestricted) {
				Account.findOne({ username: passport.user }).then(account => {
					account.touLastAgreed = TOU_CHANGES[0].changeVer;
					account.save();
					isRestricted = checkRestriction(account);
				});
			}
		});

		socket.on('acknowledgeWarning', () => {
			if (authenticated && isRestricted) {
				Account.findOne({ username: passport.user }).then(acc => {
					acc.warnings[acc.warnings.findIndex(warning => !warning.acknowledged)].acknowledged = true;
					acc.markModified('warnings');
					acc.save(() => (isRestricted = checkRestriction(acc)));
				});
			}
		});

		socket.on('handleUpdatedPlayerNote', data => {
			handleUpdatedPlayerNote(socket, passport, data);
		});

		socket.on('handleUpdatedTheme', data => {
			handleUpdatedTheme(socket, passport, data);
		});

		socket.on('updateModAction', data => {
			if (authenticated && isAEM) {
				handleModerationAction(socket, passport, data, false, modUserNames, editorUserNames.concat(adminUserNames));
			}
		});
		socket.on('addNewClaim', data => {
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				handleAddNewClaim(socket, passport, game, data);
			}
		});
		socket.on('updateGameWhitelist', data => {
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				handleUpdateWhitelist(passport, game, data);
			}
		});
		socket.on('updateTruncateGame', data => {
			handleUpdatedTruncateGame(data);
		});
		socket.on('addNewGameChat', data => {
			const game = findGame(data);
			if (isRestricted) return;
			if (authenticated) {
				handleAddNewGameChat(socket, passport, data, game, modUserNames, editorUserNames, adminUserNames, handleAddNewClaim);
			}
		});
		socket.on('updateReportGame', data => {
			try {
				handleUpdatedReportGame(socket, data);
			} catch (e) {
				console.log(e, 'err in player report');
			}
		});
		socket.on('addNewGame', data => {
			if (isRestricted) return;
			if (authenticated) {
				handleAddNewGame(socket, passport, data);
			}
		});
		socket.on('updateGameSettings', data => {
			if (authenticated) {
				handleUpdatedGameSettings(socket, passport, data);
			}
		});

		socket.on('addNewGeneralChat', data => {
			if (isRestricted) return;
			if (authenticated) {
				handleNewGeneralChat(socket, passport, data, modUserNames, editorUserNames, adminUserNames);
			}
		});
		socket.on('leaveGame', data => {
			const release = games.acquire(data.uid);
			const game = games.get(data.uid);

			socket.leave(data.uid);

			if (authenticated && game && users.isInGame(passport.user, data.uid)) {
				handleUserLeaveGame(socket, game, data, passport);
			}

			release();
		});
		socket.on('updateSeatedUser', data => {
			if (isRestricted) return;
			if (authenticated) {
				updateSeatedUser(socket, passport, data);
			}
		});
		socket.on('playerReport', data => {
			if (isRestricted || !data || !data.comment || data.comment.length > 140) return;
			if (authenticated) {
				handlePlayerReport(passport, data);
			}
		});
		socket.on('playerReportDismiss', () => {
			if (authenticated && isAEM) {
				handlePlayerReportDismiss();
			}
		});
		socket.on('updateRemake', data => {
			const game = findGame(data);
			if (authenticated && ensureInGame(passport, game)) {
				handleUpdatedRemakeGame(passport, game, data, socket);
			}
		});
		socket.on('updateBio', data => {
			if (authenticated) {
				handleUpdatedBio(socket, passport, data);
			}
		});
		// user-requests

		socket.on('getPlayerNotes', data => {
			sendPlayerNotes(socket, data);
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
		socket.on('updateUserStatus', (type, gameId) => {
			const game = findGame({ uid: gameId });
			if (authenticated && ensureInGame(passport, game)) {
				updateUserStatus(passport, game);
			} else if (authenticated) {
				updateUserStatus(passport);
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