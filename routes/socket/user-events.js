const {
	games,
	userInfo,
	groups,
	gameSets,
	options,
	userListEmitter,
	createNewBypass,
	isStandardAEM,
	genChat,
	stages,
} = require('./models');
const { getModInfo, sendGameList, joinGameLobby, sendUserReports } = require('./user-requests');
const { selectVoting } = require('./game/election.js');
const Account = require('../../models/account');
const ModAction = require('../../models/modAction');
const PlayerReport = require('../../models/playerReport');
const BannedIP = require('../../models/bannedIP');
const Profile = require('../../models/profile/index');
const { completeGame } = require('./game/end-game');
const { secureGame } = require('./util.js');
// const crypto = require('crypto');
const https = require('https');
const _ = require('lodash');
const { sendInProgressGameUpdate, sendPlayerChatUpdate } = require('./util.js');
const animals = require('../../utils/animals');
const adjectives = require('../../utils/adjectives');
const { generateCombination } = require('gfycat-style-urls');
const { obfIP } = require('./ip-obf');
const { LEGALCHARACTERS } = require('../../src/frontend-scripts/node-constants');
const { makeReport } = require('./report.js');
const { chatReplacements } = require('./chatReplacements');
const generalChatReplTime = Array(chatReplacements.length + 1).fill(0);
const interval = require('interval-promise');

/**
 *
 * @param {number} minPlayersCount
 * @param {number} maxPlayersCount
 * @param {number} excludedPlayerCount
 * @return {string}
 */
const displayWaitingForPlayers = (minPlayersCount, maxPlayersCount, excludedPlayerCount) => {
	const includedPlayerCounts = _.range(minPlayersCount, maxPlayersCount).filter(
		value => !excludedPlayerCount.includes(value)
	);

	for (const value of includedPlayerCounts) {
		if (value > game.publicPlayersState.length) {
			const count = value - game.publicPlayersState.length;

			return count === 1 ? `Waiting for ${count} more player..` : `Waiting for ${count} more players..`;
		}
	}
};

/**
 * Moves games between the 'pregame' and 'starting' phases.
 * Note: Games must be started by an external read of the `starting` gameSet.
 *
 * @param {string} gameKey - A game cache key
 */
const checkStartConditions = async (gameKey) => {

	const release = await games.acquire(gameKey).writeLock();
	const { stage } = await games.getState(gameKey, 'stage');
	const { minPlayersCount, maxPlayersCount, excludedPlayerCount } =
		await games.getConfig(gameKey, 'minPlayersCount', 'excludedPlayerCount', 'maxPlayersCount');
	const numPlayers = groups.count('players', gameKey);

	const sufficentPlayers = minPlayersCount < numPlayers || !excludedPlayerCount.includes(numPlayers);

	if (stage === stages.SETUP || stage === stages.STARTING) {

		if (sufficentPlayers) {
			/* We do have the right number of players, so game should be marked as ready to start  */
			await games.setState(gameKey, {
				stage: stages.STARTING,
				status: 'Starting game',
				readyToStartAt: new Date()
				/* We will use this time to scan through the 'starting' game set and start games that
         * are old enough. An await timer here might have odd side effects on multiple nodes.
         */
			});

			await gameSets.add('starting', gameKey);
		} else {
			/* We do not have the right number of players, so the game should not start */
			await gameSets.remove('starting', gameKey);

			await games.setState(gameKey, {
				stage: stages.SETUP,
				status: displayWaitingForPlayers(minPlayersCount, maxPlayersCount, excludedPlayerCount),
				readyToStartAt: null
			});
		}
	}
	release();
};

const crashReport = JSON.stringify({
	content: `${process.env.DISCORDADMINPING} the site just crashed or reset.`
});

const crashOptions = {
	hostname: 'discordapp.com',
	path: process.env.DISCORDCRASHURL,
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(crashReport)
	}
};

if (process.env.NODE_ENV === 'production') {
	const crashReq = https.request(crashOptions);

	crashReq.end(crashReport);
}

/**
 * Kicks all players from a game and removes that game.
 * Note: You *must* lock gameKey before calling.
 *
 * @param {string} gameKey - A game cach key
 * @return {Promise<void>}
 */
const removeGame = async (gameKey) => {
	/*
	 * It's possible there might be some users with this game set as 'currentGame'.
	 * We need to remove them -- I will assume all are in the 'players' set of the game.
	 */
	const userKeys = await groups.members('players', gameKey);
	for (const userKey of userKeys) {
		await userInfo.delete(userKey, 'currentGame');
	}

	/* Now we can clean up redis */
	await groups.emptyAll(gameKey);
	await games.remove(gameKey);
};

const calcMimumnRemake = async (gameKey) => {
	const numPlayers = await groups.count('players', gameKey);
	const numFascist = await groups.count('fascist', gameKey);
	return numPlayers - numFascist;
}

const checkRemakeConditions = async (gameKey) => {

	const release = await games.acquire(gameKey);
	const { stage } = await games.getState(gameKey, 'stage');

	if (stage !== stages.REMADE) {

		const numRemake = await groups.count('remake', gameKey);
		const numMinimumRemake = await calcMimumnRemake(gameKey);

		if (numRemake > numMinimumRemake) {
			/* Votes are sufficent, mark for remake */
			await gameSets.add('remake'. gameKey);
			await games.setState(gameKey, {
				status: 'Game is being remade',
				readyToRemakeAt: new Date()
				/* We will use this time to scan through the 'remake' game set and remake games that
         * are old enough. An await timer here might have odd side effects on multiple nodes.
         */
			});
		} else {
			/* Votes are insufficent, unmark for remake */
			await gameSets.remove('remake'. gameKey);
			await games.setState(gameKey, {
				status: 'Remake aborted',
				readyToRemakeAt: null
			});
		}
	}
	release();
};

/**
 * Removes a user from a game lobby.
 *
 * @param {string} userKey - A user cache key
 */
const handleUserLeaveGame = async (userKey) => {

	/* Get the user's current game (they cant very well leave a game they are not in, can they?) */
	const { currentGame } = await userInfo.get(userKey, 'currentGame');

	if (currentGame !== null) {

		/*
		 * If the user is actually seated in the game (not just spectating it),
		 * then we will need to update the game information.
		 */
		if (await groups.isMember(userKey, 'players', currentGame)) {

			/* The user is disconnected and is playing -- remove them from present players */
			await groups.remove(userKey, 'present', currentGame);

			const { stage } = await games.getState(currentGame , 'stage');
			const numPresent = await groups.count('present', currentGame);

			if (numPresent < 1) {
				/*
				 * If no one is present,
				 * then we should remove this game.
				 */
				await userInfo.delete(userKey, 'currentGame');
				await removeGame(currentGame);

			} else if (stage !== stages.PLAYING) {
				/*
				 * If there are more than one person present and the game is not being played,
				 * then we should remove this player.
				 */
				await userInfo.delete(userKey, 'currentGame');
				await groups.removeFromAll(userKey, currentGame); /* Remove the user from all of this game's groups */
				await checkStartConditions(currentGame);

			} else if (stage === stages.PLAYING) {
				/*
				 * If the game is in play,
				 * then we may need to update remakes.
				 */

				/* Remake votes are void if you leave */
				await groups.remove(userKey, 'remake', currentGame);
				await checkRemakeConditions(currentGame);
			}
		}
	}
};

/**
 * Handles a socket disconnect.
 *
 * Note: This function may acquire a game lock that must be released before returning.
 * @param {string} [userKey] - An optional user cache key
 */
const handleSocketDisconnect = async (userKey) => {

	/* Remove the user from the online group */
	await groups.remove('online', userKey);

	if (userKey != null) {
		/* If the user was in a game lobby, pretend that they left */
		await handleUserLeaveGame(userKey);
	}
};

/**
 * Gives userKey a seat at gameKey.
 *
 * @param {object} socket - A socket reference
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {string} [password] - Game password
 */
const updateSeatedUser = async (socket, userKey, gameKey, password) => {
	const limitNewPlayers = await options.get('limitNewPlayers', false);
	// prevents race condition between 1) taking a seat and 2) the game starting

	const stage = await games.getState(gameKey, 'stage');

	if (stage === stages.SETUP || stage === stages.STARTING) {
		/* if the game is not being played yet */

		const user = await userInfo.get(userKey);
		const numPlayers = await groups.count('players', gameKey);
		const { maxPlayersCount, isRainbow, isPrivate, privatePassword, whitelist, blacklist, eloMinimum }
		  = await games.getConfig(gameKey, 'maxPlayersCount', 'isRainbow', 'isPrivate', 'privatePassword', 'whitelist', 'blacklist', 'eloMinimum');

		if (user.wins + user.losses < 3 && limitNewPlayers && !isPrivate) {
			return;
		}

		const isNotMaxedOut = numPlayers < maxPlayersCount;
		const isNotInGame = !(await groups.isMember('players', userKey, gameKey));
		const isRainbowSafe = isRainbow || (isRainbow && user.wins + user.losses > 49);
		const isPrivateSafe = !isPrivate|| (isPrivate && password === privatePassword) || whitelist.includes(userKey);
		const isBlacklistSafe = !blacklist.includes(userKey);
		const isMeetingEloMinimum = eloMinimum == null || eloMinimum <= user.eloSeason || eloMinimum <= user.eloOverall;

		if (isNotMaxedOut && isNotInGame && isRainbowSafe && isPrivateSafe && isBlacklistSafe && isMeetingEloMinimum) {
			await groups.add('players', userKey, gameKey);
			await games.setCard(gameKey, userKey, {
				displayed: false,
				flipped: false,
				front: 'secretrole',
				back: {}
			});
			socket.emit('updateSeatForUser', true);
			await checkStartConditions(gameKey);
			io.sockets.in(gameKey).emit('gameUpdate', secureGame(game));
			sendGameList();
		}
	}
};

module.exports.updateSeatedUser = updateSeatedUser;

/**
 * @param {object} socket - Socket reference
 * @param {string} userKey - A user cache key
 * @param {object} data - Message payload
 */
module.exports.handleUpdatedBio = (socket, userKey, data) => {
	// Authentication Assured in routes.js
	Account.findOne({ username: userKey }).then(account => {
		account.bio = data;
		account.save();
	});
};

/**
 * Gets the formatted staffrole for a userKey.
 *
 * @param {string} userKey - A user cache key
 * @return {string}
 */
const getStaffRole = async userKey => {
	const userGroups = await groups.ofMember(userKey);
	if (userGroups.includes('moderator')) {
		return 'moderator';
	} else if (userGroups.includes('editor')) {
		return 'editor';
	} else if (userGroups.includes('admin')) {
		return 'admin';
	}
	return '';
};

/**
 * @param {object} socket - A socket reference
 * @param {string} userKey - A user cache key
 * @param {object} data - Message payload
 */
module.exports.handleAddNewGame = async (socket, userKey, data) => {
  const gameCreationDisabled = await options.get('gameCreationDisabled', false);
  const limitNewPlayers = await options.get('limitNewPlayers', false);

	if (gameCreationDisabled || (!data.privatePassword && limitNewPlayers)) {
		return;
	}

	const release = await userInfo.acquire(userKey).writeLock();
	try {
		console.log('acquired');
		const user = await userInfo.get(userKey);

		if ('currentGame' in user) {
			return;
		}

		let a;
		let playerCounts = [];
		for (a = Math.max(data.minPlayersCount, 5); a <= Math.min(10, data.maxPlayersCount); a++) {
			if (!data.excludedPlayerCount.includes(a)) playerCounts.push(a);
		}
		if (playerCounts.length === 0) {
			// Someone is messing with the data, ignore it
			return;
		}

		const excludes = [];
		for (a = playerCounts[0]; a <= playerCounts[playerCounts.length - 1]; a++) {
			if (!playerCounts.includes(a)) excludes.push(a);
		}

		if (!data.gameName || data.gameName.length > 20 || !LEGALCHARACTERS(data.gameName)) {
			// Should be enforced on the client. Copy-pasting characters can get past the LEGALCHARACTERS client check.
			return;
		}

		if (data.eloSliderValue && (user.eloSeason < data.eloSliderValue || user.eloOverall < data.eloSliderValue)) {
			return;
		}

		if (data.customGameSettings && data.customGameSettings.enabled) {
			if (!data.customGameSettings.deckState || !data.customGameSettings.trackState) return;

			const validPowers = ['investigate', 'deckpeek', 'election', 'bullet', 'reverseinv', 'peekdrop'];
			if (!data.customGameSettings.powers || data.customGameSettings.powers.length != 5) return;
			for (let a = 0; a < 5; a++) {
				if (data.customGameSettings.powers[a] == '' || data.customGameSettings.powers[a] == 'null') data.customGameSettings.powers[a] = null;
				else if (data.customGameSettings.powers[a] && !validPowers.includes(data.customGameSettings.powers[a])) return;
			}

			if (!(data.customGameSettings.hitlerZone >= 1) || data.customGameSettings.hitlerZone > 5) return;
			if (
				!data.customGameSettings.vetoZone ||
				data.customGameSettings.vetoZone <= data.customGameSettings.trackState.fas ||
				data.customGameSettings.vetoZone > 5
			) {
				return;
			}

			// Ensure that there is never a fas majority at the start.
			// Custom games should probably require a fixed player count, which will be in playerCounts[0] regardless.
			if (!(data.customGameSettings.fascistCount >= 1) || data.customGameSettings.fascistCount + 1 > playerCounts[0] / 2) return;

			// Ensure standard victory conditions can be met for both teams.
			if (!(data.customGameSettings.deckState.lib >= 5) || data.customGameSettings.deckState.lib > 8) return;
			if (!(data.customGameSettings.deckState.fas >= 6) || data.customGameSettings.deckState.fas > 19) return;

			// Roundabout way of checking for null/undefined but not 0.
			if (!(data.customGameSettings.trackState.lib >= 0) || data.customGameSettings.trackState.lib > 4) return;
			if (!(data.customGameSettings.trackState.fas >= 0) || data.customGameSettings.trackState.fas > 5) return;

			// Need at least 13 cards (11 on track plus two left-overs) to ensure that the deck does not run out.
			if (data.customGameSettings.deckState.lib + data.customGameSettings.deckState.fas < 13) return;

			if (
				!(data.customGameSettings.trackState.lib >= 0) ||
				data.customGameSettings.trackState.lib > 4 ||
				!(data.customGameSettings.trackState.fas >= 0) ||
				data.customGameSettings.trackState.fas > 5
			) {
				return;
			}

			data.casualGame = true; // Force this on if everything looks ok.
			playerCounts = [playerCounts[0]]; // Lock the game to a specific player count. Eventually there should be one set of settings per size.
		} else {
			data.customGameSettings = {
				enabled: false
			};
		}

		const gameKey = generateCombination(3, '', true);
		await gameSets.add('active', gameKey);
		/* State is for things that can change after game start */
		await games.setState(gameKey, {
			status: `Waiting for ${playerCounts[0] - 1} more players..`,
			stage: stages.STARTING,
			fascistDeck: 11,
			liberalDeck: 6,
			fascistDiscard: 0,
			liberalDiscard: 0,
			fascistPlayed: 0,
			liberalPlayed: 0,
			fascistHand: 0,
			liberalHand: 0,
		});
		/* Config is for things that should not change after game start */
		await games.setConfig(gameKey, {
			name: user.isPrivate ? 'Private Game' : data.gameName ? data.gameName : 'New Game',
			whiteList: [],
			blacklist: user.blacklist,
			flag: data.flag || 'none', // TODO: verify that the flag exists, or that an invalid flag does not cause issues
			minPlayersCount: playerCounts[0],
			gameCreatorName: user.userName,
			excludedPlayerCount: excludes,
			maxPlayersCount: playerCounts[playerCounts.length - 1],
			experiencedMode: data.experiencedMode,
			disableChat: data.disableChat,
			isVerifiedOnly: data.isVerifiedOnly,
			disableObserver: data.disableObserver,
			disableGamechat: data.disableGamechat,
			isRainbow: user.wins + user.losses > 49 ? data.rainbowgame : false,
			isBlindMode: data.blindMode,
			isRimedMode: typeof data.timedMode === 'number' && data.timedMode >= 2 && data.timedMode <= 6000 ? data.timedMode : false,
			isFlappyMode: data.flappyMode,
			isFlappyOnlyMode: data.flappyMode && data.flappyOnlyMode,
			isCasual: typeof data.timedMode === 'number' && data.timedMode < 30 && !data.casualGame ? true : data.casualGame,
			rebalance6p: data.rebalance6p,
			rebalance7p: data.rebalance7p,
			rebalance9p2f: data.rebalance9p2f,
			isUnlisted: data.unlistedGame && !data.privatePassword,
			isPrivate: user.isPrivate ? (data.privatePassword ? data.privatePassword : 'private') : !data.unlistedGame && data.privatePassword,
			privateOnly: user.isPrivate,
			password: data.privatePassword,
			eloMinimum: data.eloSliderValue,
			isCustom: data.customGameSettings.enabled,
			timeCreated: currentTime,
			...data.customGameSettings /* Just chuck the custom game settings in here too */
		});

		await userInfo.set(userKey, 'timeLastGameCreated', currentTime);
		console.log('done');
	} catch (e) {
		console.error(e);
	} finally {
		console.log('unlocking');
		release();
		console.log('unlock');
	}

	console.log('joining game');

	/* Auto-join the creator */
	await joinGameLobby(socket, gameKey, userKey);
	await updateSeatedUser(socket, userKey, gameKey, data.privatePassword);
};

/**
 * @param {Object} socket - Socket reference
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {Object} data - Message payload
 */
module.exports.handleUpdatedRemakeGame = async (socket, userKey, gameKey) => {

	const { stage, seats } = await games.getState(gameKey, 'stage', 'seats');

	if ( stage !== stages.REMADE ) {

		const { isPrivate } = await games.getConfig(gameKey, 'isPrivate');

		const chat = {
			timestamp: new Date(),
			chat: isPrivate ? [{ text: 'Player ' }, { text: `${userKey} {${seats.indexOf(userKey) + 1}} `,  type: 'player' }] : [{ text: 'A player' }]
		};

		const numRemake = await groups.count('remake', gameKey);
		const numMinimumRemake = await calcMimumnRemake(gameKey);

		if (await groups.isMember('remake', userKey, gameKey)) {
			/* Toggle remake off */
			socket.emit('updateRemakeVoting', false);
			await groups.remove('remake', userKey, gameKey);
			chat.chat.push({
				text: ` has voted to remake this game. (${numRemake}/${numMinimumRemake})`
			});
		} else {
			/* Toggle remake on */
			socket.emit('updateRemakeVoting', true);
			await groups.add('remake', userKey, gameKey);
			chat.chat.push({
				text: ` has voted to remake this game. (${numRemake}/${numMinimumRemake})`
			});
		}

		await checkRemakeConditions();

		await games.writeChannel(gameKey, channels.GAME.PUBLIC, chat);
	}
};

/**
 * Adds a new game chat to a game.
 *
 * @param {Object} socket - A socket reference
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {Object} data - A message payload
 */
module.exports.handleAddNewGameChat = async (socket, userKey, gameKey, data) => {
	if (!data.chat || !data.chat.length || data.chat.length > 300) return;
	const chat = data.chat.trim();

	const isAEM = await isStandardAEM(userKey);

	const { stage, phase, president, chancellor, electionCount} =
		await games.getState(gameKey, 'stage', 'phase', 'president', 'chancellor', 'messageTimeout', 'electionCount');
	const { name, isCasual } =
		await games.getConfig(gameKey, 'name', 'isCasual', 'disableChat', 'disableObserver');
	const isPlayer = await groups.isMember('players', userKey, gameKey);
	const isDead = await groups.isMember('dead', userKey, gameKey);
	const { wins, losses } = await userInfo.get(userKey);

	if (isAEM) {
		/* Handle AEM chat */
		await games.writeChannel(gameKey, channels.CHAT.PLAYER, {
			timestamp: new Date(),
			userName: gameKey,
			chat: data.chat,
			staffRole: await getStaffRole(userKey)
		});

	} else if (
		isPlayer
		&& (stage !== stages.PLAYING || !isDead)
		&& (stage !== stages.PLAYING || (phase === 'presidentSelectingPolicy' && userKey === president))
		&& (stage !== stages.PLAYING || (phase === 'chancellorSelectingPolicy' && userKey === chancellor))
	) {
		/* Handle player chat */
		await games.writeChannel(gameKey, channels.CHAT.PLAYER, {
			timestamp: new Date(),
			userName: gameKey,
			chat: data.chat
		});

		/* Ping the mods if necessary (possible locking operation) */
		const pingMods = /^@(mod|moderator|editor|aem|mods) (.*)$/i.exec(chat);
		if (pingMods && userKey != null ) {
			const release = await games.acquire(gameKey);
			const { lastModPing } = games.getState(gameKey, 'lastModPing');
			if (lastModPing != null && now > lastModPing + 180000) {
				await games.setState(gameKey, { lastModPing: now });
				makeReport(
					{
						player: userKey,
						situation: `"${pingMods[2]}".`,
						election: electionCount,
						title: name,
						uid: gameKey,
						gameType: isCasual ? 'Casual' : 'Ranked'
					},
					gameKey,
					'ping'
				);
			} else {
				socket.emit('sendAlert', `You can't ping mods for another ${(game.lastModPing + 180000 - Date.now()) / 1000} seconds.`);
			}
			release();
		}

	} else if (
		!isPlayer
		&& wins + losses >= 10
	) {
		/* Handle observer chat */
		await games.writeChannel(gameKey, channels.CHAT.OBSERVER, {
			timestamp: new Date(),
			userName: gameKey,
			chat: data.chat
		});
	}
};

/**
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {object} data - Socket data
 */
module.exports.handleUpdateWhitelist = async (userKey, gameKey, data) => {

	release = games.acquire(gameKey);
	const { isPrivate, password, whitelist, gameCreatorName } = await games.getConfig(gameKey, 'isPrivate', 'password', 'whitelist');

	const isPrivateSafe = !isPrivate || (isPrivate && (data.password === password || whitelist.includes(userKey)));

	// Only update the whitelist if whitelistsed, has password, or is the creator
	if (isPrivateSafe || gameCreatorName === userKey) {
		await games.setConfig(gameKey, {whitelist:  data.whitelistPlayers});
	}
	release()
};

/**
 * @param {object} socket - A socket reference
 * @param {string} userKey - A user cache key
 * @param {object} data - Message payload
 */
module.exports.handleNewGeneralChat = async (socket, userKey, data) => {
	if (!data.chat.length || data.chat.length > 300) return;

	const isAEM = await isStandardAEM(userKey);

	const leniancy = 0.5;
	const timeSince = await genChat.timeSinceLast();
	if (timeSince < leniancy * 1000) return; // Prior chat was too recent.

	const { wins, losses } = await userInfo.get(userKey, 'wins', 'losses');
	const gameTotal = wins + losses;

	if (gameTotal >= 10 || isAEM) {
		const newChat = {
			time: new Date(),
			chat: data.chat.trim(),
			userName: userKey,
			staffRole: await getStaffRole(userKey)
		};
		const { staffIncognito } = await userInfo.get(userKey, 'staffIncognito');
		if (isAEM && staffIncognito ) {
			newChat.hiddenUsername = newChat.userName;
			newChat.staffRole = 'moderator';
			newChat.userName = 'Incognito';
		}
		await genChat.push(newChat);
		const history = await genChat.get();
		socket.emit('generalChats', history);
	}
};

/**
 * @param {object} socket - socket reference.
 * @param {string} userKey - socket authentication.
 * @param {string} gameKey - game reference.
 */
module.exports.handleGameFreeze = async (socket, userKey, gameKey) => {

	if (await groups.isMember('players', userKey, gameKey)) {
		socket.emit('sendAlert', 'You cannot freeze the game whilst playing.');
		return;
	}

	let msg;
	if (await gameSets.isMember('frozen', gameKey)) {
		await gameSets.remove('frozen', gameKey);
		msg = 'unfrozen';
	} else {
		const modaction = new ModAction({
			date: new Date(),
			modUserName: userKey,
			userActedOn: gameKey,
			modNotes: '',
			actionTaken: 'Game Freeze'
		});
		modaction.save();
		await gameSets.add('frozen', gameKey);
		msg = 'frozen';
	}

	await games.writeChannel(gameKey, channels.GAME.PUBLIC, {
		chat: `(AEM) ${userKey} has ${msg} the game. ${game.gameState.isGameFrozen ? 'All actions are prevented.' : ''}`,
		timestamp: new Date()
	});
};

/**
 * @param {object} socket - Socket reference
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 */
module.exports.handleModPeekVotes = async (socket, userKey, gameKey) => {

	if (await groups.isMember('players', userKey, gameKey)) {
		socket.emit('sendAlert', 'You cannot peek votes whilst playing.');
		return;
	}

	if (!await gameSets.isMember('peaked', gameKey)) {
		await gameSets.add('peaked', gameKey);
		new ModAction({
			date: new Date(),
			modUserName: userKey,
			userActedOn: gameKey,
			modNotes: '',
			actionTaken: 'Peek Votes'
		}).save();
	}

	const { seats } = await games.getState(gameKey, 'seats', 'hitler');
	let output = "";
	for (const playerKey of await groups.members('players', gameKey)) {
		output += `Seat ${seats.indexOf(playerKey) + 1} - `;

		const playerGroups = await groups.ofMember(playerKey, gameKey);

		if ('hitler' in playerGroups) {
			output += 'Hitler   - ';
		} else if ('fascist' in playerGroups) {
			output += 'Fascist  - ';
		} else if ('liberal' in playerGroups) {
			output += 'Liberal  - ';
		} else {
			output += 'NoRole   - ';
		}

		if ('dead' in playerGroups) {
			output += 'Dead'
		} else if ('ja' in playerGroups) {
			output += 'Ja'
		} else if ('nein' in playerGroups) {
			output += 'Nein'
		} else {
			output += 'Not Voted';
		}
		output += '\n';
	}
	socket.emit('sendAlert', output);
};

/**
 * @param {object} socket - Socket reference.
 * @param {string} userKey - A user cache key
 * @param {object} data - Message payload
 * @param {boolean} skipCheck - True if there was an account lookup to find the IP
 */
module.exports.handleModerationAction = async (socket, userKey, data, skipCheck) => {
	// Authentication Assured in routes.js

	if (data.userName) {
		data.userName = data.userName.trim();
	}

	if (!skipCheck && !data.isReportResolveChange) {
		if (!data.ip || data.ip === '') {
			if (data.userName && data.userName !== '') {
				if (data.userName.startsWith('-')) {
					try {
						data.ip = obfIP(data.userName.substring(1));
					} catch (e) {
						data.ip = '';
						console.log(e);
					}
				} else {
					// Try to find the IP from the account specified if possible.
					const account = await Account.findOne({ username: data.userName });
					if (account) data.ip = account.lastConnectedIP || account.signupIP;
					await module.exports.handleModerationAction(socket, userKey, data, true);
					return;
				}
			}
		} else {
			if (data.ip.startsWith('-')) {
				try {
					data.ip = obfIP(data.ip.substring(1));
				} catch (e) {
					data.ip = '';
					console.log(e);
				}
			} else {
				// Should never happen, so pass it back in with no IP.
				data.ip = '';
				await module.exports.handleModerationAction(socket, userKey, data, false);
				// Note: Check is not skipped here, we want to still check the username.
				return;
			}
		}
	}

	if ((!data.ip || data.ip === '') && (data.action === 'timeOut' || data.action === 'ipban' || data.action === 'getIP' || data.action === 'clearTimeoutIP')) {
		// Failed to get a relevant IP, abort the action since it needs one.
		socket.emit('sendAlert', 'That action requires a valid IP.');
		return;
	}

	const isSuperMod = superModUserNames.includes(passport.user) || newStaff.editorUserNames.includes(passport.user);

	const affectedSocketId = Object.keys(io.sockets.sockets).find(
		socketId => io.sockets.sockets[socketId].handshake.session.passport && io.sockets.sockets[socketId].handshake.session.passport.user === data.userName
	);

	if (await groups.authorize(userKey, { any: ['admin', 'editor', 'moderator', 'trialmod'] })) {

		if (data.isReportResolveChange) {
			PlayerReport.findOne({ _id: data._id })
				.then(report => {
					if (report) {
						report.isActive = !report.isActive;
						report.save(() => {
							sendUserReports(socket);
						});
					}
				})
				.catch(err => {
					console.log(err, 'err in finding player report');
				});
		} else if (data.action === 'getFilteredData') {
			return;
			let queryObj;

			if (data.comment && (data.comment.split('.').length > 1 || data.comment.split(':').length > 1)) {
				queryObj = {
					ip: new RegExp(`^${obfIP(data.comment.substring(1))}`)
				};
			} else {
				queryObj = {
					userActedOn: data.comment
				};
			}
			const userNames = userList.map(user => user.userName);

			Account.find({ username: userNames, 'gameSettings.isPrivate': { $ne: true } })
				.then(users => {
					getModInfo(users, socket, queryObj);
				})
				.catch(err => {
					console.log(err, 'err in sending mod info');
				});
		} else {
			const modaction = new ModAction({
				date: new Date(),
				modUserName: userKey,
				userActedOn: data.userName,
				modNotes: data.comment,
				ip: data.ip,
				actionTaken: typeof data.action === 'string' ? data.action : data.action.type
			});
			/**
			 * @param {string} username - name of user.
			 */
			const logOutUser = username => {
				const bannedUserlistIndex = userList.findIndex(user => user.userName === username);

				if (io.sockets.sockets[affectedSocketId]) {
					io.sockets.sockets[affectedSocketId].emit('manualDisconnection');
					io.sockets.sockets[affectedSocketId].disconnect();
				}

				if (bannedUserlistIndex >= 0) {
					userList.splice(bannedUserlistIndex, 1);
				}

				// destroySession(username);
			};

			/**
			 * @param {string} username - name of user.
			 */
			const banAccount = username => {
				Account.findOne({ username })
					.then(account => {
						if (account) {
							// account.hash = crypto.randomBytes(20).toString('hex');
							// account.salt = crypto.randomBytes(20).toString('hex');
							account.isBanned = true;
							account.save(() => {
								const bannedAccountGeneralChats = generalChats.list.filter(chat => chat.userName === username);

								bannedAccountGeneralChats.reverse().forEach(chat => {
									generalChats.list.splice(generalChats.list.indexOf(chat), 1);
								});
								logOutUser(username);
								io.sockets.emit('generalChats', generalChats);
							});
						}
					})
					.catch(err => {
						console.log(err, 'ban user err');
					});
			};

			switch (data.action) {
				case 'clearTimeout':
					Account.findOne({ username: data.userName })
						.then(account => {
							if (account) {
								account.isTimeout = new Date(0);
								account.isBanned = false;
								account.save();
							} else {
								socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							}
						})
						.catch(err => {
							console.log(err, 'clearTimeout user err');
						});
					break;
				case 'warn':
					const warning = {
						time: new Date(),
						text: data.comment,
						moderator: userKey,
						acknowledged: false
					};

					Account.findOne({ username: data.userName }).then(user => {
						if (user) {
							if (user.warnings && user.warnings.length > 0) {
								user.warnings.push(warning);
							} else {
								user.warnings = [warning];
							}
							user.save(() => {
								if (io.sockets.sockets[affectedSocketId]) {
									io.sockets.sockets[affectedSocketId].emit('checkRestrictions');
								}
							});
						} else {
							socket.emit('sendAlert', `That user doesn't exist`);
							return;
						}
					});
					break;
				case 'removeWarning':
					Account.findOne({ username: data.userName }).then(user => {
						if (user) {
							if (user.warnings && user.warnings.length > 0) {
								socket.emit('sendAlert', `Warning with the message: "${user.warnings.pop().text}" deleted.`);
							} else {
								socket.emit('sendAlert', `That user doesn't have any warnings.`);
								return;
							}
							user.markModified('warnings');
							user.save(() => {
								if (io.sockets.sockets[affectedSocketId]) {
									io.sockets.sockets[affectedSocketId].emit('checkRestrictions');
								}
							});
						} else {
							socket.emit('sendAlert', `That user doesn't exist`);
							return;
						}
					});
					break;
				case 'clearTimeoutIP':
					BannedIP.remove({ ip: data.ip }, (err, res) => {
						if (err) socket.emit('sendAlert', `IP clear failed:\n${err}`);
					});
					break;
				case 'modEndGame':
					const gameToEnd = games[data.uid];

					if (gameToEnd && gameToEnd.private && gameToEnd.private.seatedPlayers) {
						for (player of gameToEnd.private.seatedPlayers) {
							if (data.modName === player.userName) {
								socket.emit('sendAlert', 'You cannot end a game whilst playing in it.');
								return;
							}
						}
					}

					if (gameToEnd && gameToEnd.private && gameToEnd.private.seatedPlayers) {
						gameToEnd.chats.push({
							userName: data.modName,
							chat: 'This game has been ended by a moderator, game deletes in 5 seconds.',
							isBroadcast: true,
							timestamp: new Date()
						});
						completeGame(gameToEnd, data.winningTeamName);
						setTimeout(() => {
							gameToEnd.publicPlayersState.forEach(player => (player.leftGame = true));
							delete games[gameToEnd.general.uid];
							;
						}, 5000);
					}
					break;
				case 'setVerified':
					Account.findOne({ username: data.userName }).then(account => {
						if (account) {
							account.verified = true;
							account.verification.email = 'mod@VERIFIEDVIAMOD.info';
							account.save();
						} else socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
					});
					break;
				case 'makeBypass':
					const key = createNewBypass();
					if (modaction.modNotes.length) modaction.modNotes += '\n';
					modaction.modNotes += `Created bypass key: ${key}`;
					socket.emit('sendAlert', `Created bypass key: ${key}`);
					break;
				case 'getIP':
					if (isSuperMod) {
						console.log(data, 'd');
						socket.emit('sendAlert', `Requested IP: ${data.ip}`);
					} else {
						socket.emit('sendAlert', 'Only editors and admins can request a raw IP.');
						return;
					}
					break;
				case 'rainbowUser':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.losses = account.losses >= 50 ? account.losses : 50;
									account.wins = account.wins >= 1 ? account.wins : 1;
									account.save();
									logOutUser(data.userName);
								} else socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							})
							.catch(err => {
								console.log(err, 'rainbow user error');
							});
					} else {
						socket.emit('sendAlert', 'Only editors and admins can rainbow a user.');
						return;
					}
					break;
				case 'deleteUser':
					if (isSuperMod) {
						// let account, profile;
						Account.findOne({ username: data.userName }).then(acc => {
							account = acc;
							acc.delete();
							Profile.findOne({ _id: data.userName }).then(prof => {
								profile = prof;
								prof.delete();
							});
						});
						// TODO: Add Account and Profile Backups (for accidental deletions)
					} else {
						socket.emit('sendAlert', 'Only editors and admins can delete users.');
						return;
					}
					break;
				case 'renameUser':
					if (isSuperMod) {
						let success = false;
						let fail = false;
						Account.findOne({ username: data.comment }).then(account => {
							Profile.findOne({ _id: data.comment }).then(profile => {
								if (profile) {
									socket.emit('sendAlert', `Profile of ${data.comment} already exists`);
									fail = true;
									// TODO: Add Profile Backup (for accidental/bugged renames)
								}
							});
							if (fail) {
								return;
							}
							if (account) {
								socket.emit('sendAlert', `User ${data.comment} already exists`);
							} else {
								Account.findOne({ username: data.userName }).then(account => {
									if (io.sockets.sockets[affectedSocketId]) {
										io.sockets.sockets[affectedSocketId].emit('manualDisconnection');
									}
									if (account) {
										account.username = data.comment;
										account.save();
										success = true;
										logOutUser(data.userName);
									} else {
										socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
									}
									if (!success) {
										return;
									}
									success = false;
									Profile.findOne({ _id: data.userName }).then(profile => {
										const newProfile = JSON.parse(JSON.stringify(profile));
										newProfile._id = data.comment;
										const renamedProfile = new Profile(newProfile);
										renamedProfile.save();
										Profile.remove({ _id: data.userName }, () => {
											success = true;
										});
									});
								});
							}
						});
					} else {
						socket.emit('sendAlert', 'Only editors and admins can rename users.');
						return;
					}
					break;
				case 'ban':
					banAccount(data.userName);
					break;
				case 'deleteBio':
					Account.findOne({ username: data.userName }).then(account => {
						if (account) {
							account.bio = '';
							account.save();
						} else socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
					});
					break;
				case 'logoutUser':
					logOutUser(data.username);
					break;
				case 'setSticky':
					generalChats.sticky = data.comment.trim().length ? `(${userKey}) ${data.comment.trim()}` : '';
					io.sockets.emit('generalChats', generalChats);
					break;
				case 'broadcast':
					const discordBroadcastBody = JSON.stringify({
						content: `Text: ${data.comment}\nMod: ${userKey}`
					});
					const discordBroadcastOptions = {
						hostname: 'discordapp.com',
						path: process.env.DISCORDBROADCASTURL,
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(discordBroadcastBody)
						}
					};
					try {
						const broadcastReq = https.request(discordBroadcastOptions);
						broadcastReq.end(discordBroadcastBody);
					} catch (e) {
						console.log(e, 'err in broadcast');
					}

					Object.keys(games).forEach(gameName => {
						games[gameName].chats.push({
							userName: `[BROADCAST] ${data.modName}`,
							chat: data.comment,
							isBroadcast: true,
							timestamp: new Date()
						});
					});

					generalChats.list.push({
						userName: `[BROADCAST] ${data.modName}`,
						time: new Date(),
						chat: data.comment,
						isBroadcast: true
					});

					if (data.isSticky) {
						generalChats.sticky = data.comment.trim().length ? `(${userKey}) ${data.comment.trim()}` : '';
					}

					io.sockets.emit('generalChats', generalChats);
					break;
				case 'ipban':
					const ipban = new BannedIP({
						bannedDate: new Date(),
						type: 'small',
						ip: data.ip
					});

					ipban.save(() => {
						Account.find({ lastConnectedIP: data.ip }, function(err, users) {
							if (users && users.length > 0) {
								users.forEach(user => {
									if (isSuperMod) {
										banAccount(user.username);
									} else {
										logOutUser(user.username);
									}
								});
							}
						});
					});
					break;

				case 'fragbanSmall':
					if (isSuperMod) {
						const fragbans = new BannedIP({
							bannedDate: new Date(Date.now() + 64800000),
							type: 'fragbanSmall',
							ip: data.userName
						});
						modaction.ip = modaction.userActedOn;
						modaction.userActedOn = 'RAW IP FRAGMENT';
						fragbans.save();
					} else {
						socket.emit('sendAlert', 'Only editors and admins can perform large IP bans.');
						return;
					}
					break;
				case 'fragbanLarge':
					if (isSuperMod) {
						const fragbanl = new BannedIP({
							bannedDate: new Date(Date.now() + 604800000),
							type: 'fragbanLarge',
							ip: data.userName
						});
						modaction.ip = modaction.userActedOn;
						modaction.userActedOn = 'RAW IP FRAGMENT';
						fragbanl.save();
					} else {
						socket.emit('sendAlert', 'Only editors and admins can perform fragment IP bans.');
						return;
					}
					break;
				case 'timeOut':
					const timeout = new BannedIP({
						bannedDate: new Date(),
						type: 'small',
						ip: data.ip
					});
					timeout.save(() => {
						Account.find({ userName: data.userName }, function(err, users) {
							if (users && users.length > 0) {
								users.forEach(user => {
									user.isTimeout = new Date(Date.now() + 18 * 60 * 60 * 1000);
								});
								users.forEach(user => {
									user.save(() => {
										logOutUser(data.userName);
									});
								});
							}
						});
					});
					break;
				case 'timeOut2':
					Account.findOne({ username: data.userName })
						.then(account => {
							if (account) {
								account.isTimeout = new Date(Date.now() + 18 * 60 * 60 * 1000);
								account.save(() => {
									logOutUser(data.userName);
								});
							} else {
								socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							}
						})
						.catch(err => {
							console.log(err, 'timeout2 user err');
						});
					break;
				case 'timeOut3':
					const timeout3 = new BannedIP({
						bannedDate: new Date(),
						type: 'tiny',
						ip: data.ip
					});
					timeout3.save(() => {
						Account.find({ lastConnectedIP: data.ip }, function(err, users) {
							if (users && users.length > 0) {
								users.forEach(user => {
									logOutUser(user.username);
								});
							}
						});
					});
					break;
				case 'timeOut4':
					Account.findOne({ username: data.userName })
						.then(account => {
							if (account) {
								account.isTimeout = new Date(Date.now() + 6 * 60 * 60 * 1000);
								account.save(() => {
									logOutUser(data.userName);
								});
							} else {
								socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							}
						})
						.catch(err => {
							console.log(err, 'timeout4 user err');
						});
					break;
				case 'togglePrivate':
					Account.findOne({ username: data.userName })
						.then(account => {
							if (account) {
								const { isPrivate } = account.gameSettings;

								account.gameSettings.isPrivate = !isPrivate;
								account.gameSettings.privateToggleTime = !isPrivate ? new Date('2099-01-01 00:00:00.000') : Date.now();
								account.save(() => {
									logOutUser(data.userName);
								});
							} else {
								socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							}
						})
						.catch(err => {
							console.log(err, 'private convert user err');
						});
					break;
				case 'togglePrivateEighteen':
					Account.findOne({ username: data.userName })
						.then(account => {
							if (account) {
								const { isPrivate } = account.gameSettings;

								account.gameSettings.isPrivate = !isPrivate;
								account.gameSettings.privateToggleTime = Date.now();
								account.save(() => {
									logOutUser(data.userName);
								});
							} else {
								socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							}
						})
						.catch(err => {
							console.log(err, 'private convert user err');
						});
					break;
				case 'clearGenchat':
					if (data.userName && data.userName.length > 0) {
						generalChats.list = generalChats.list.filter(chat => chat.userName !== data.userName);

						// clearedGeneralChats.reverse().forEach(chat => {
						// 	generalChats.list.splice(generalChats.list.indexOf(chat), 1);
						// });
						io.sockets.emit('generalChats', generalChats);
					} else {
						generalChats.list = [];
						io.sockets.emit('generalChats', generalChats);
					}

					break;
				case 'deleteProfile':
					if (isSuperMod) {
						// TODO: Add Profile Backup (for accidental/bugged deletions)
						Profile.findOne({ _id: data.userName })
							.remove(() => {
								logOutUser(data.userName);
							})
							.catch(err => {
								console.log(err);
							});
					} else {
						socket.emit('sendAlert', 'Only editors and admins can delete profiles.');
						return;
					}
					break;
				case 'ipbanlarge':
					const ipbanl = new BannedIP({
						bannedDate: new Date(),
						type: 'big',
						ip: data.ip
					});

					if (isSuperMod) {
						ipbanl.save(() => {
							Account.find({ lastConnectedIP: data.ip }, function(err, users) {
								if (users && users.length > 0) {
									users.forEach(user => {
										banAccount(user.username);
									});
								}
							});
						});
					} else {
						socket.emit('sendAlert', 'Only editors and admins can perform large IP bans.');
						return;
					}
					break;
				case 'deleteCardback':
					Account.findOne({ username: data.userName })
						.then(account => {
							if (account) {
								account.gameSettings.customCardback = '';
								const user = userList.find(u => u.userName === data.userName);
								if (user) {
									user.customCardback = '';
									userListEmitter.send = true;
								}
								Object.keys(games).forEach(uid => {
									const game = games[uid];
									const foundUser = game.publicPlayersState.find(user => user.userName === data.userName);
									if (foundUser) {
										foundUser.customCardback = '';
										io.sockets.in(uid).emit('gameUpdate', secureGame(game));
										;
									}
								});
								account.save(() => {
									if (io.sockets.sockets[affectedSocketId]) {
										io.sockets.sockets[affectedSocketId].emit('gameSettings', account.gameSettings);
									}
								});
							} else {
								socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
							}
						})
						.catch(err => {
							console.log(err);
						});
					break;
				case 'disableAccountCreation':
					accountCreationDisabled.status = true;
					break;
				case 'enableAccountCreation':
					accountCreationDisabled.status = false;
					break;
				case 'disableVPNCheck':
					bypassVPNCheck.status = true;
					break;
				case 'enableVPNCheck':
					bypassVPNCheck.status = false;
					break;	
				case 'disableIpbans':
					ipbansNotEnforced.status = true;
					break;
				case 'enableIpbans':
					ipbansNotEnforced.status = false;
					break;
				case 'disableGameCreation':
					gameCreationDisabled.status = true;
					break;
				case 'enableGameCreation':
					gameCreationDisabled.status = false;
					break;
				case 'enableLimitNewPlayers':
					limitNewPlayers.status = true;
					break;
				case 'disableLimitNewPlayers':
					limitNewPlayers.status = false;
					break;
				case 'removeContributor':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.isContributor = false;
									account.save(() => {
										const idx = newStaff.contributorUserNames.indexOf(account.username);
										if (idx != -1) newStaff.contributorUserNames.splice(idx, 1);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'removeStaffRole':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.staffRole = '';
									account.save(() => {
										let idx = newStaff.modUserNames.indexOf(account.username);
										if (idx != -1) newStaff.modUserNames.splice(idx, 1);
										idx = newStaff.editorUserNames.indexOf(account.username);
										if (idx != -1) newStaff.editorUserNames.splice(idx, 1);
										idx = newStaff.trialmodUserNames.indexOf(account.username);
										if (idx != -1) newStaff.trialmodUserNames.splice(idx, 1);
										idx = newStaff.altmodUserNames.indexOf(account.username);
										if (idx != -1) newStaff.altmodUserNames.splice(idx, 1);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'promoteToContributor':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.isContributor = true;
									account.save(() => {
										newStaff.contributorUserNames.push(account.username);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'promoteToTrialMod':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.staffRole = 'trialmod';
									account.save(() => {
										newStaff.trialmodUserNames.push(account.username);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'promoteToAltMod':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.staffRole = 'altmod';
									account.save(() => {
										newStaff.altmodUserNames.push(account.username);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'promoteToMod':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.staffRole = 'moderator';
									account.save(() => {
										newStaff.modUserNames.push(account.username);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'promoteToEditor':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.staffRole = 'editor';
									account.save(() => {
										newStaff.editorUserNames.push(account.username);
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'promoteToVeteran':
					if (isSuperMod) {
						Account.findOne({ username: data.userName })
							.then(account => {
								if (account) {
									account.staffRole = 'veteran';
									account.save(() => {
										logOutUser(account.username);
									});
								} else {
									socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								}
							})
							.catch(err => {
								console.log(err);
							});
					}
					break;
				case 'regatherAEMList':
					if (!isSuperMod) {
						socket.emit('sendAlert', 'Only editors and admins can refresh the AEM usernames list.');
						return;
					}
					break;
				case 'resetServer':
					if (isSuperMod) {
						console.log('server crashing manually via mod action');
						const crashReport = JSON.stringify({
							content: `${process.env.DISCORDADMINPING} the site was just reset manually by an admin or editor.`
						});

						const crashOptions = {
							hostname: 'discordapp.com',
							path: process.env.DISCORDCRASHURL,
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								'Content-Length': Buffer.byteLength(crashReport)
							}
						};

						if (process.env.NODE_ENV === 'production') {
							const crashReq = https.request(crashOptions);

							crashReq.end(crashReport);
						}
						setTimeout(() => {
							crashServer();
						}, 1000);
					} else {
						socket.emit('sendAlert', 'Only editors and admins can restart the server.');
						return;
					}
					break;
				default:
					if (data.userName.substr(0, 7) === 'DELGAME') {
						const game = games[data.userName.slice(7)];

						if (game) {
							delete games[game.general.uid];
							game.publicPlayersState.forEach(player => (player.leftGame = true)); // Causes timed games to stop.
							;
						}
					} else if (data.userName.substr(0, 13) === 'RESETGAMENAME') {
						const game = games[data.userName.slice(13)];
						if (game) {
							if (modaction.modNotes.length > 0) {
								modaction.modNotes += ` - Name: "${game.general.name}" - Creator: "${game.general.gameCreatorName}"`;
							} else {
								modaction.modNotes = `Name: "${game.general.name}" - Creator: "${game.general.gameCreatorName}"`;
							}
							games[game.general.uid].general.name = 'New Game';
							;
						}
					} else if (isSuperMod && data.action.type) {
						const setType = /setRWins/.test(data.action.type)
							? 'rainbowWins'
							: /setRLosses/.test(data.action.type)
							? 'rainbowLosses'
							: /setWins/.test(data.action.type)
							? 'wins'
							: 'losses';
						const number =
							setType === 'wins'
								? data.action.type.substr(7)
								: setType === 'losses'
								? data.action.type.substr(9)
								: setType === 'rainbowWins'
								? data.action.type.substr(8)
								: data.action.type.substr(10);
						const isPlusOrMinus = number.charAt(0) === '+' || number.charAt(0) === '-';

						if (!isNaN(parseInt(number, 10)) || isPlusOrMinus) {
							Account.findOne({ username: data.userName })
								.then(account => {
									if (account) {
										account[setType] = isPlusOrMinus
											? number.charAt(0) === '+'
												? account[setType] + parseInt(number.substr(1, number.length))
												: account[setType] - parseInt(number.substr(1, number.length))
											: parseInt(number);

										if (!data.action.isNonSeason) {
											account[`${setType}Season${currentSeasonNumber}`] = isPlusOrMinus
												? account[`${setType}Season${currentSeasonNumber}`]
													? number.charAt(0) === '+'
														? account[`${setType}Season${currentSeasonNumber}`] + parseInt(number.substr(1, number.length))
														: account[`${setType}Season${currentSeasonNumber}`] - parseInt(number.substr(1, number.length))
													: parseInt(number.substr(1, number.length))
												: parseInt(number);
										}
										account.save();
									} else socket.emit('sendAlert', `No account found with a matching username: ${data.userName}`);
								})
								.catch(err => {
									console.log(err, 'set wins/losses error');
								});
						}
					}
			}

			const niceAction = {
				comment: 'Comment',
				warn: 'Issue Warning',
				removeWarning: 'Delete Warning',
				getIP: 'Get IP',
				ban: 'Ban',
				setSticky: 'Set Sticky',
				ipbanlarge: '1 Week IP Ban',
				ipban: '18 Hour IP Ban',
				enableAccountCreation: 'Enable Account Creation',
				disableAccountCreation: 'Disable Account Creation',
				enableVPNCheck: 'Enable VPN Check',
				disableVPNCheck: 'Disable VPN Check',
				togglePrivate: 'Toggle Private (Permanent)',
				togglePrivateEighteen: 'Toggle Private (Temporary)',
				timeOut: 'Timeout 18 Hours (IP)',
				timeOut2: 'Timeout 18 Hours',
				timeOut3: 'Timeout 1 Hour (IP)',
				timeOut4: 'Timeout 6 Hours',
				clearTimeout: 'Clear Timeout',
				clearTimeoutIP: 'Clear IP Ban',
				modEndGame: 'End Game',
				deleteGame: 'Delete Game',
				enableIpBans: 'Enable IP Bans',
				disableIpBans: 'Disable IP Bans',
				disableGameCreation: 'Disable Game Creation',
				enableGameCreation: 'Enable Game Creation',
				disableIpbans: 'Disable IP Bans',
				enableIpbans: 'Enable IP Bans',
				broadcast: 'Broadcast',
				fragBanLarge: '1 Week Fragment Ban',
				fragBanSmall: '18 Hour Fragment Ban',
				clearGenchat: 'Clear General Chat',
				deleteUser: 'Delete User',
				deleteBio: 'Delete Bio',
				deleteProfile: 'Delete Profile',
				deleteCardback: 'Delete Cardback',
				removeContributor: 'Remove Contributor Role',
				resetGameName: 'Reset Game Name',
				rainbowUser: 'Grant Rainbow',
				removeStaffRole: 'Remove Staff Role',
				promoteToContributor: 'Promote (Contributor)',
				promoteToAltMod: 'Promote (AEM Alt)',
				promoteToTrialMod: 'Promote (Trial Mod)',
				promoteToVeteran: 'Promote (Veteran AEM)',
				promoteToMod: 'Promote (Mod)',
				promoteToEditor: 'Promote (Editor)',
				makeBypass: 'Create Bypass Key',
				bypassKeyUsed: 'Consume Bypass Key',
				resetServer: 'Server Restart',
				regatherAEMList: 'Refresh AEM List'
			};

			const modAction = JSON.stringify({
				content: `Date: *${new Date()}*\nStaff member: **${modaction.modUserName}**\nAction: **${niceAction[modaction.actionTaken] ||
					modaction.actionTaken}**\nUser: **${modaction.userActedOn}**\nComment: **${modaction.modNotes}**.`
			});

			const modOptions = {
				hostname: 'discordapp.com',
				path: process.env.DISCORDMODLOGURL,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(modAction)
				}
			};

			if (process.env.NODE_ENV === 'production') {
				try {
					const modReq = https.request(modOptions);

					modReq.end(modAction);
				} catch (error) {}
			}
			modaction.save();
		}
	}
};

/**
 * @param {string} userKey - A user cache key
 * @param {object} data - A message payload
 */
module.exports.handlePlayerReport = async (userKey, data) => {
	const user = await userInfo.get(userKey);
	const gameKey = user.currentGame;

	if (data.userName !== 'from replay' && (!user || user.wins + user.losses < 2) && process.env.NODE_ENV === 'production') {
		return;
	}

	const playerReport = new PlayerReport({
		date: new Date(),
		gameUid: gameKey,
		reportingPlayer: userKey,
		reportedPlayer: data.reportedPlayer,
		reason: data.reason,
		gameType: data.gameType,
		comment: data.comment,
		isActive: true
	});

	if (!/^(afk\/leaving game|abusive chat|cheating|gamethrowing|stalling|botting|other)$/.exec(playerReport.reason)) {
		return;
	}

	switch (playerReport.reason) {
		case 'afk/leaving game':
			playerReport.reason = 'AFK/Leaving Game';
			break;
		case 'abusive chat':
			playerReport.reason = 'Abusive Chat';
			break;
		case 'cheating':
			playerReport.reason = 'Cheating';
			break;
		case 'gamethrowing':
			playerReport.reason = 'Gamethrowing';
			break;
		case 'stalling':
			playerReport.reason = 'Stalling';
			break;
		case 'botting':
			playerReport.reason = 'Botting';
			break;
		case 'other':
			playerReport.reason = 'Other';
			break;
	}

	const httpEscapedComment = data.comment.replace(/( |^)(https?:\/\/\S+)( |$)/gm, '$1<$2>$3').replace(/@/g, '`@`');

	const { stage } = await games.getState(gameKey, )
	const { blindMode } = await games.getConfig(gameKey, 'blindMode');

	const blindModeAnonymizedPlayer = blindMode
		? stage === stages.PLAYING
			? `${data.reportedPlayer.split(' ')[0]} Anonymous`
			: 'Anonymous'
		: data.reportedPlayer;

	const body = JSON.stringify({
		content: `Game UID: <https://secrethitler.io/game/#/table/${gameKey}>\nReported player: ${blindModeAnonymizedPlayer}\nReason: ${playerReport.reason}\nComment: ${httpEscapedComment}`
	});

	const options = {
		hostname: 'discordapp.com',
		path: process.env.DISCORDURL,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body)
		}
	};

	try {
		const req = https.request(options);
		req.end(body);
	} catch (error) {
		console.log(error, 'Caught exception in player request https request to discord server');
	}

	playerReport.save(err => {
		if (err) {
			console.log(err, 'Failed to save player report');
			return;
		}
	});
};

module.exports.handlePlayerReportDismiss = () => {
	Account.find({ staffRole: { $exists: true, $ne: 'veteran' } }).then(accounts => {
		accounts.forEach(account => {
			const onlineSocketId = Object.keys(io.sockets.sockets).find(
				socketId => io.sockets.sockets[socketId].handshake.session.passport && io.sockets.sockets[socketId].handshake.session.passport.user === account.username
			);

			account.gameSettings.newReport = false;

			if (onlineSocketId) {
				io.sockets.sockets[onlineSocketId].emit('reportUpdate', false);
			}
			account.save();
		});
	});
};

module.exports.handleHasSeenNewPlayerModal = (socket, userKey) => {
	if (userKey != null) {
		Account.findOne({ username: userKey }).then(account => {
			account.hasNotDismissedSignupModal = false;
			socket.emit('checkRestrictions');
			account.save();
		});
	}
};

module.exports.handleUserLeaveGame = handleUserLeaveGame;

module.exports.handleSocketDisconnect = handleSocketDisconnect;

module.exports.handleFlappyEvent = async (data) => {
	const gameKey = data.uid;
	if (io.sockets.adapter.rooms[gameKey] == null) {
		return;
	}
	const roomSockets = Object.keys(io.sockets.adapter.rooms[game.general.uid].sockets).map(sockedId => io.sockets.connected[sockedId]);
	const updateFlappyRoom = newData => {
		roomSockets.forEach(sock => {
			if (sock) {
				sock.emit('flappyUpdate', newData);
			}
		});
	};

	updateFlappyRoom(data);

	if (data.type === 'startFlappy') {
		game.flappyState = {
			controllingLibUser: '',
			controllingFascistUser: '',
			liberalScore: 0,
			fascistScore: 0,
			pylonDensity: 1.3,
			flapDistance: 1,
			pylonOffset: 1.3,
			passedPylonCount: 0
		};

		game.general.status = 'FLAPPY HITLER: 0 - 0';
		io.sockets.in(game.general.uid).emit('gameUpdate', game);

		game.flappyState.pylonGenerator = setInterval(() => {
			const offset = Math.floor(Math.random() * 50 * game.flappyState.pylonOffset);
			const newData = {
				type: 'newPylon',
				pylonType: 'normal',
				offset
			};

			updateFlappyRoom(newData);
		}, 1500 * game.flappyState.pylonDensity);
	}

	if (data.type === 'collision') {
		game.flappyState[`${data.team}Score`]++;
		clearInterval(game.flappyState.pylonGenerator);
		// game.general.status = 'FLAPPY HITLER: x - x';
		// io.sockets.in(game.general.uid).emit('gameUpdate', game);
	}

	if (data.type === 'passedPylon') {
		game.flappyState.passedPylonCount++;
		game.general.status = `FLAPPY HITLER: ${game.flappyState.liberalScore} - ${game.flappyState.fascistScore} (${game.flappyState.passedPylonCount})`;

		io.sockets.in(game.general.uid).emit('gameUpdate', game);
	}
};
