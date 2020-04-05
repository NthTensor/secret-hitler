const {
	handleUpdatedTruncateGame,
	handleUpdatedReportGame,
	handleAddNewGame,
	handleAddNewGameChat,
	handleNewGeneralChat,
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
	handleModPeekVotes,
	handleGameFreeze,
	handleHasSeenNewPlayerModal,
	handleFlappyEvent,
} = require('./user-events');
const {
	sendUserReports,
	joinGameLobby,
	sendUserGameSettings,
	sendModInfo,
	sendGeneralChats,
	sendUserList,
	sendReplayGameChats,
	sendSignups,
	sendAllSignups,
	sendPrivateSignups,
} = require('./user-requests');
const { selectChancellor, selectVoting, selectPresidentPolicy, selectChancellorPolicy, selectChancellorVoteOnVeto, selectPresidentVoteOnVeto } = require('./game/election');
const {
	selectSpecialElection,
	selectPartyMembershipInvestigate,
	selectPolicies,
	selectPlayerToExecute,
	selectPartyMembershipInvestigateReverse,
	selectOnePolicy,
	selectBurnCard
} = require('./game/policy-powers');
const { games, gameSets, userInfo, groups, emoteList, isStandardAEM } = require('./models');
const Account = require('../../models/account');
const { TOU_CHANGES } = require('../../src/frontend-scripts/node-constants.js');
const version = require('../../version');
const interval = require('interval-promise');

/**
 * Returns the sockets userKey if authenticated and null otherwise.
 *
 * @param {Object} socket
 * @return {string|null}
 */
const attemptAuthenticate = socket => {
	try {
		return socket.handshake.session.passport.user;
	} catch {
		return null
	}
};

/**
 * Returns true if a gameKey is active, false otherwise.
 *
 * @param {string} gameKey
 * @return {Promise<boolean>}
 */
const isActiveGame = async (gameKey) => {
	if (gameKey != null) {
		return gameSets.isMember('active', gameKey);
	} else {
		return new Promise(() => false);
	}
};

/**
 * Returns the curent game of a user;
 *
 * @param {string} userKey - A user cache key
 * @return {Promise<string|null>}
 */
const getActiveGame = async (userKey) => {
	if (userKey != null) {
		const { currentGame } = await userInfo.get(userKey, 'currentGame');
		if (await isActiveGame(currentGame)) {
			return currentGame;
		} else {
			return null;
		}
	}
	return new Promise(() => null);
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

	io.on('connection', async socket => {

		socket.emit('version', { current: version });

		/* see if this session is authenciated as a user */
		const userKey = attemptAuthenticate(socket);

		let lastVersionSeen;

		/* If this socket is logged in as a user */
		if (userKey != null) {

			await groups.add('online', userKey);
			const account = await Account.findOne({ username: userKey });
			const { sockets } = io.sockets;
			/* Try to find an old socket with the same user */
			const oldSocketID = Object.keys(sockets)
				.find(socketID =>
					sockets[socketID].handshake.session.passport &&
					Object.keys(sockets[socketID].handshake.session.passport).length &&
					sockets[socketID].handshake.session.passport.user === userKey &&
					socketID !== socket.id
				);

			/* Load the user into the cache */
			await userInfo.set(userKey, {
				wins: account.wins,
				losses: account.losses,
				rainbowWins: account.rainbowWins,
				rainbowLosses: account.rainbowLosses,
				isPrivate: account.gameSettings.isPrivate,
				blacklist: account.gameSettings.blacklist,
				customCardback: account.gameSettings.customCardback,
				customCardbackUid: account.gameSettings.customCardbackUid,
				previousSeasonAward: account.gameSettings.previousSeasonAward,
				eloOverall: account.eloOverall,
				eloSeason: account.eloSeason,
			});

			if (account.staffRole != null) {
				await groups.add(account.staffRole, userKey);
			} else if (account.isContributor) {
				await groups.add('contributor', userKey);
			}

			/* Users can only open one socket at a time */
			if (oldSocketID && sockets[oldSocketID]) {
				sockets[oldSocketID].emit('manualDisconnection');
				delete sockets[oldSocketID];
			}

			lastVersionSeen = account.lastVersionSeen || 'none';

			/* elevate permissions of compliant authenticated users */
			await checkRestriction(socket, userKey, account);
		} else {
			lastVersionSeen = 'none';
		}

		/* Routing */

		socket.conn.on('upgrade', async () => {
			socket.emit('version', {
				current: version,
				lastSeen: lastVersionSeen
			});
			socket.emit('emoteList', emoteList);
			await sendGeneralChats(socket);
			/* If the user is in a game, set them back as connected */
			const gameKey = await getActiveGame(userKey);
			if (gameKey !== null) {
				await groups.add('present', userKey, gameKey);
				socket.join(gameKey);
				socket.emit('updateSeatForUser');
			}
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

		socket.on('flappyEvent', async data => {
			const gameKey = await getActiveGame(userKey);
			if (
				userKey != null
				&& await groups.authorize(userKey, {none: ['restricted']})
				&& await isActiveGame(gameKey)
			) {
				await handleFlappyEvent(gameKey, data);
			}
		});

		socket.on('hasSeenNewPlayerModal', () => {
			if (userKey != null) {
				handleHasSeenNewPlayerModal(socket, userKey);
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

		socket.on('confirmTOU', async () => {
			if (
				userKey != null
				&& await groups.authorize(userKey, {none: ['restricted']})
			) {
				const account = await Account.findOne({ username: userKey });
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

		socket.on('updateModAction', async data => {
			if (
				userKey != null
				&& await isStandardAEM(userKey)
			) {
				await handleModerationAction(socket, userKey, data, false);
			}
		});

		socket.on('addNewClaim', async data => {
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null) {
				await handleAddNewClaim(socket, userKey, gameKey, data);
				await handleAddNewClaim(socket, userKey, gameKey, data);
			}
		});

		socket.on('updateGameWhitelist', async data => {
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null) {
				await handleUpdateWhitelist(userKey, data.uid, data)
			}
		});

		socket.on('updateTruncateGame', data => {
			handleUpdatedTruncateGame(data);
		});

		socket.on('addNewGameChat', async data => {
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null && await groups.authorize(userKey, {none: ['restricted']})) {
				await handleAddNewGameChat(socket, userKey, data.uid, data);
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
			if (userKey != null && await groups.authorize(userKey, {none: ['restricted']})) {
				await handleAddNewGame(socket, userKey, data);
			}
		});

		socket.on('addNewGeneralChat', async data => {
			if (
				userKey != null
				&& data != null
				&& 'chat' in data
				&& await groups.authorize(userKey, {none: ['private', 'restricted']})
			) {
				await handleNewGeneralChat(socket, userKey, data);
			}
		});

		socket.on('leaveGame', async data => {
			socket.leave(data.uid);
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null) {
				await handleUserLeaveGame(userKey);
			}
		});

		socket.on('updateSeatedUser', async data => {
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null && await groups.authorize(userKey, {none: ['restricted']})) {
				await updateSeatedUser(socket, userKey, gameKey, data.password);
			}
		});

		socket.on('playerReport', async data => {
			const gameKey = await getActiveGame(userKey);
			if (
				userKey != null
				&& gameKey != null
				&& data != null
				&& 'comment' in data
				&& typeof data.comment == 'string'
				&& data.comment.length > 140
			) {
				await handlePlayerReport(userKey, gameKey, data);
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
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null) {
				await handleUpdatedRemakeGame(socket, userKey, gameKey);
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

		socket.on('getGameInfo', async uid => {
			await joinGameLobby(socket, uid, userKey);
		});

		socket.on('getUserList', () => {
			sendUserList(socket);
		});

		socket.on('getGeneralChats', async () => {
			await sendGeneralChats(socket);
		});

		socket.on('getUserGameSettings', () => {
			sendUserGameSettings(socket, userKey);
		});

		socket.on('selectedChancellorVoteOnVeto', async data => {
			const gameKey = await getActiveGame(userKey);
			if (userKey != null && gameKey != null && await groups.authorize(userKey, {none: ['restricted']})) {
				await selectChancellorVoteOnVeto(socket, userKey, data.uid, data);
			}
		});

		socket.on('getModInfo', async count => {
			if (
				userKey != null
				&& groups.authorize(userKey, {
					any: ['admin', 'editor', 'moderator', 'trailmod' ],
					none: ['altmod', 'veteran']
				})
			) {
				await sendModInfo(socket, userKey, count);
			}
		});

		socket.on('modPeekVotes', async data => {
			if (
				userKey != null
				&& await isStandardAEM(userKey)
				&& 'uid' in data
				&& await isActiveGame(data.uid)
			) {
				handleModPeekVotes(socket, userKey, gameKey)
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

		socket.on('getReplayGameChats', async gameKey => {
			if (gameKey != null) {
				await sendReplayGameChats(socket, gameKey);
			}
		});

		// election

		socket.on('presidentSelectedChancellor', async data => {
			if (
				userKey != null
				&& await groups.authorize(userKey, {none: ['restricted']})
				&& 'uid' in data
				&& await isActiveGame(data.uid)
				&& await isCurrentGame(userKey, data.uid)
			) {
				await selectChancellor(socket, userKey, data.uid, data);
			}
		});

		socket.on('selectedVoting', async data => {
			if (
				userKey != null
				&& await groups.authorize(userKey, {none: ['restricted']})
				&& 'uid' in data
				&& await isActiveGame(data.uid)
				&& await isCurrentGame(userKey, data.uid)
			) {
				selectVoting(socket, userKey, data.uid, data);
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