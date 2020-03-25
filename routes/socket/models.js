/* removed temporarily
const { CURRENTSEASONNUMBER } = require('../../src/frontend-scripts/node-constants');
const Account = require('../../models/account');
const ModAction = require('../../models/modAction');
*/
const { generateCombination } = require('gfycat-style-urls');
const BannedIP = require('../../models/bannedIP');
const Mortice = require('mortice');

const fs = require('fs');
const emotes = [];
fs.readdirSync('public/images/emotes', { withFileTypes: true }).forEach(file => {
	if (file.name.endsWith('.png')) emotes[emotes.length] = [file.name.substring(0, file.name.length - 4), file];
});

// Ordered list of sizes, used for good packing of images with a fixed size.
// It will also not go over 10 in a given dimension (making 10x10 the max), to avoid sizes like 23x1 (resorting 6x4 instead).
// If multiple options exist, it will pick the more square option, and prefers images to be wider instead of taller.
// Sizes below 20 are also not included, as we should always have at least that many emotes.
const sizeMap = [
	[5, 4], // 20
	[6, 4], // 24
	[5, 5], // 25
	[9, 3], // 27
	[7, 4], // 28
	[6, 5], // 30
	[8, 4], // 32
	[7, 5], // 35
	[6, 6], // 36
	[8, 5], // 40
	[7, 6], // 42
	[9, 5], // 45
	[8, 6], // 48
	[10, 5], // 50
	[9, 6], // 54
	[8, 7], // 56
	[10, 6], // 60
	[9, 7], // 63
	[8, 8], // 64
	[10, 7], // 70
	[9, 8], // 72
	[10, 8], // 80
	[9, 9], // 81
	[10, 9], // 90
	[10, 10] // 100
];

const numEmotes = emotes.length;
let sheetSize = [10, 10];
sizeMap.forEach(size => {
	const space = size[0] * size[1];
	if (space >= numEmotes && space < sheetSize[0] * sheetSize[1]) sheetSize = size;
});

let curCell = 0;

emotes.forEach(emote => {
	const thisCell = curCell;
	curCell++;
	const loc = [thisCell % sheetSize[0], Math.floor(thisCell / sheetSize[0])];
	emote[1] = loc;
});

module.exports.emoteList = emotes;

const staffList = [];
Account.find({ staffRole: { $exists: true } }).then(accounts => {
	accounts.forEach(user => (staffList[user.username] = user.staffRole));
});

module.exports.getPowerFromRole = role => {
	if (role === 'admin') return 3;
	if (role === 'editor') return 2;
	if (role === 'moderator') return 1;
	if (role === 'altmod') return 0; // Report AEM delays will check for >= 0
	if (role === 'trialmod') return 0;
	if (role === 'contributor') return -1;
	return -1;
};

module.exports.getPowerFromName = name => {
	if (module.exports.newStaff.editorUserNames.includes(name)) return getPowerFromRole('editor');
	if (module.exports.newStaff.modUserNames.includes(name)) return getPowerFromRole('moderator');
	if (module.exports.newStaff.altmodUserNames.includes(name)) return getPowerFromRole('altmod');
	if (module.exports.newStaff.trialmodUserNames.includes(name)) return getPowerFromRole('trialmod');
	if (module.exports.newStaff.contributorUserNames.includes(name)) return getPowerFromRole('contributor');

	const user = module.exports.userList.find(user => user.userName === name);
	if (user) return getPowerFromRole(user.staffRole);
	else if (staffList[name]) return getPowerFromRole(staffList[name]);
	else return -1;
};

module.exports.getPowerFromUser = user => {
	if (module.exports.newStaff.editorUserNames.includes(user.userName)) return getPowerFromRole('editor');
	if (module.exports.newStaff.modUserNames.includes(user.userName)) return getPowerFromRole('moderator');
	if (module.exports.newStaff.altmodUserNames.includes(user.userName)) return getPowerFromRole('altmod');
	if (module.exports.newStaff.trialmodUserNames.includes(user.userName)) return getPowerFromRole('trialmod');
	if (module.exports.newStaff.contributorUserNames.includes(user.userName)) return getPowerFromRole('contributor');
	return getPowerFromRole(user.staffRole);
};

const acquire = prefix => async function (key) {
	return Mortice(`${prefix}:${key}`).writeLock();
};

const acquireAll = prefix => async function (keys) {
	const releases = await Promise.all(keys.map(key => Mortice(`${prefix}:${key}`).writeLock()));
	return () => {
		releases.forEach(release => release());
	};
};

const acquireEach = prefix => async function* (keys) {
	for (const key of keys) {
		yield { key, release: await Mortice(`${prefix}:${key}`).writeLock() };
	}
};

/**
 * Games model.
 */
module.exports.games = {
	acquire: acquire('game'),
	acquireAll: acquireAll('game'),
	acquireEach: acquireEach('game'),

	/**
	 * Stores games in redis.
	 * Note: Chat will not be saved if you changed it manually. See `pushChat` instead.
	 *
	 * Be sure to acquire a write lock before calling this method.
	 *
	 * @param {string|Object} gameKeys - A key, or an object
	 * @param {Object} [game] - An optional game
	 *
	 * @example
	 *
	 *     	games.set('key', game);
	 *      games.set({key1: game1, key2: game2});
	 */
	async set(gameKeys, game) {
		if (typeof gameKeys === 'string') {
			delete game.chats;
			return redis.set(`game:${gameKeys}:data`, JSON.stringify(game));
		} else {
			gameKeys.values().forEach(game => delete game.chats);
			return redis.mset(gameKeys);
		}
	},

	/**
	 * Like games.set, but for when you are sure the game is not already in redis.
	 *
	 * @param {Object} game - A new game
	 * @return {string} - A cache key
	 */
	async register(game) {
		const key = generateCombination(3, '', true);
		const chats = [...game.chats];
		delete game.chats;
		await redis
			.pipeline()
			.set(`game:${key}:data`, JSON.stringify(game))
			.rpush(`game:${key}:chat`, chats)
			.sadd(`game+set:active`, key)
			.exec();
		return key;
	},

	/**
	 * Removes games from redis.
	 *
	 * @param {string|string[]} gameKeys - Game cache keys
	 * @return {Promise<void>}
	 */
	async remove(gameKeys) {
		if (Array.isArray(gameKeys)) {
			await redis
				.pipeline()
				.srem(`game+set:active`, gameKeys)
				.del(gameKeys.map(gameKey => `game:${gameKey}:data`))
				.del(gameKeys.map(gameKey => `game:${gameKey}:chat`))
				.exec();
		} else {
			await redis
				.pipeline()
				.srem(`game+set:active`, gameKeys)
				.del(`game:${gameKeys}:data` `game:${gameKeys}:chat`)
				.exec();
		}
	},

	/**
	 * Retrieves games from redis.
	 *
	 * @param {string|string[]} gameKeys - A key or list of keys
	 * @return {Promise<Object[]>|Promise<Object>}
	 */
	async get(gameKeys) {
		if (Array.isArray(gameKeys)) {
			return redis.mget(gameKeys).then(str_ents => str_ents.map(JSON.parse));
		} else {
			return redis.get(gameKeys).then(str => JSON.parse(str));
		}
	},

	/**
	 * Retrieves the keys of all active games.
	 *
	 * @return {Promise<string[]>}
	 */
	async keys() {
		return redis.smembers('game+set:active');
	},

	/**
	 * Push a new chat onto a game's chatroom.
	 * Note: You do not need to acquire a lock to push new chat.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {Object|Object[]} chats - A chat object or array of chat objects
	 * @return {Promise<void>}
	 */
	async chatPush(gameKey, chats) {
		if (Array.isArray(chats)) {
			await redis.rpush(`game:${gameKey}:chat`, chats.map(chat => JSON.stringify(chat)));
		} else {
			await redis.rpush(`game:${gameKey}:chat`, JSON.stringify(chats));
		}
	},

	/**
	 * Retrieves an entire chat log for a game.
	 *
	 * @param {string} gameKey - A game cache key
	 * @return {Promise<Object[]>}
	 */
	async chatGet(gameKey) {
		return redis.get(`game:${gameKey}:chat`).then(chats => chats.map(JSON.parse));
	},

	/**
	 * Determine whether a game is still active.
	 *
	 * @param {string} gameKey - A game cache key
	 * @return {Promise<boolean>}
	 */
	async isActive(gameKey) {
		return redis.smembers(`game+set:active`, gameKey);
	}
};

/**
 * Groups model.
 * Used to store information about sets of users.
 */
module.exports.groups = {
	/**
	 * Add users to a group.
	 * Note: Groups will not automatically persist across multiple connections
	 *
	 * @param {string} groupKey - A group cache key
	 * @param {string} userKeys - One or more user cache keys
	 * @return {Promise<void>}
	 */
	async add(groupKey, userKeys) {
		await redis
			.multi()
			.sadd(`groups:${groupKey}`, userKeys)
			.sadd(`user+groups:${userKeys}`, groupKey)
			.exec();
	},

	/**
	 * Remove users from a group.
	 *
	 * @param {string} groupKey - A group cache key
	 * @param {string} userKeys - One or more user cache keys
	 * @return {Promise<void>}
	 */
	async remove(groupKey, userKeys) {
		await redis
			.multi()
			.srem(`groups:${groupKey}`, userKeys)
			.srem(`user+groups:${userKeys}`, groupKey)
			.exec();
	},

	/**
	 * List all members of a group.
	 *
	 * @param {string[]} groupKey - A group cache key
	 * @return {Promise<string[]>}
	 */
	async members(groupKey) {
		return redis.smembers(`groups:${groupKey}`);
	},

	/**
	 * List all groups of a member.
	 *
	 * @param {string} userKey - A user cache key
	 * @return {Promise<String[]>}
	 */
	async ofMember(userKey) {
		return redis.smembers(`user+groups:${userKey}`);
	},

	/**
	 * Determine whether a user is a member of a group.
	 *
	 * @param {string} groupKey - A group cache key
	 * @param {string} userKey - A user cache key
	 * @return {Promise<boolean>}
	 */
	async isMember(groupKey, userKey) {
		return redis.sismember(`groups:${groupKey}`, userKey);
	},

	/**
	 * Checks to see if a user's groups matches a set of requirements.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {Object} policy - An object with only boolean parameters
	 * @return {Promise<boolean>}
	 *
	 * @example
	 *
	 *     	groups.authorize('key', {any: ['contributor', 'veteran'], all: ['moderator', 'online'], none: [admin]}));
	 */
	async authorize(userKey, policy) {
		const groups = await this.ofMember(userKey);
		/* all */
		if ('all' in policy) {
			if (policy.all.some(group => !groups.includes(group))) return false;
		}
		if ('none' in policy) {
			if (policy.none.some(group => groups.includes(group))) return false;
		}
		if ('any' in policy) {
			if (policy.any.every(group => !groups.includes(group))) return false;
		}
		return true;
	}
};

/**
 * User info model.
 * Stores things like active game, and number of wins/losses.
 * Staff role and binary membership properties are modeled with groups.
 */
module.exports.userInfo = {
	acquire: acquire('user+info'),
	acquireAll: acquireAll('user+info'),
	acquireEach: acquireEach('user+info'),

	/**
	 * Sets user properties.
	 * Note: You should acquire a lock before calling this.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {object|string} info - Either a properties object or the name of a property
	 * @param {object} [value] - If info is the name of a property, then this is it's value
	 * @return {Promise<void>}
	 *
	 * @example
	 *
	 *     	userInfo.set('key', 'prop', 'value);
	 *      userInfo.set('key', {prop1: 'value1', prop2: 'value2'});
	 */
	async set(userKey, info, value) {
		if (typeof info === 'string') {
			await redis.hset(`user+info:${userKey}`, info, value);
		} else {
			await redis.hset(`user+info:${userKey}`, info);
		}
	},

	/**
	 * Gets user properties.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {string|string[]} [info] - Optional list of parameters to fetch
	 * @return {Promise<*>}
	 *
	 * @example
	 *
	 *     	userInfo.get('key');
	 *      userInfo.get('key', 'prop');
	 *      userInfo.get('key', ['prop1', 'prop2']);
	 */
	async get(userKey, info) {
		if (typeof info !== 'undefined') {
			return redis.hgetall(`user+info:${userKey}`);
		} else {
			return redis.hget(`user+info:${userKey}`, info);
		}
	}

};

/**
 * General chat model.
 */
module.exports.genChat = {

	/**
	 * Pushes a new chat to gen-chat and truncates gen-chat to 100 elements.
	 *
	 * @param {Object|Object[]} chats
	 * @return {Promise<void>}
	 */
	async push(chats) {
		if (Array.isArray(chats)) {
			await redis
				.pipeline()
				.rpush(`gen+chat`, chats.map(chat => JSON.stringify(chat)))
				.ltrim(`gen+chat`, -99, -1)
				.exec();
		} else {
			await redis
				.pipeline()
				.rpush(`gen+chat`, JSON.stringify(chats))
				.ltrim(`gen+chat`, -99, -1)
				.exec();
		}
	},

	/**
	 * Deletes gen-chat.
	 *
	 * @return {Promise<void>}
	 */
	async clear() {
		await redis.del(`gen+chat`);
	},

	/**
	 * Retrieves all gen-chat
	 *
	 * @return {Promise<Object[]>}
	 */
	async get() {
		return redis.get(`gen+chat`).then(chats => chats.map(JSON.parse));
	}
};

/**
 * Options model.
 * Store global boolean options here.
 */
module.exports.options = {
	acquire: acquire('opt'),
	acquireAll: acquireAll('opt'),
	acquireEach: acquireEach('opt'),

	/**
	 * Sets a global property.
	 * Note: You should acquire a lock before calling this.
	 *
	 * @param {string} option - An option name
	 * @param {boolean} value - A value to store
	 * @return {Promise<void>}
	 */
	async set(option, value) {
		await redis.set(`opt:${option}`, value ? 'true' : 'false');
	},

	/**
	 * Gets a global property.
	 *
	 * @param {string} option - An option name
	 * @param {boolean} def - Default return if no property is set
	 * @return {Promise<boolean>}
	 */
	async get(option, def) {
		const value = await redis.get(`opt:${option}`);
		if (value !== null) {
			return value === 'true';
		} else {
			return def;
		}
	}
};

// set of profiles, no duplicate usernames
/**
 * @return // todo
 */
module.exports.profiles = (() => {
	const profiles = [];
	const MAX_SIZE = 100;
	const get = username => profiles.find(p => p._id === username);
	const remove = username => {
		const i = profiles.findIndex(p => p._id === username);
		if (i > -1) return profiles.splice(i, 1)[0];
	};
	const push = profile => {
		if (!profile) return profile;
		remove(profile._id);
		profiles.unshift(profile);
		profiles.splice(MAX_SIZE);
		return profile;
	};

	return { get, push };
})();

module.exports.formattedUserList = isAEM => {
	const prune = value => {
		// Converts things like zero and null to undefined to remove it from the sent data.
		return value ? value : undefined;
	};

	return module.exports.userList
		.map(user => ({
			userName: user.userName,
			wins: prune(user.wins),
			losses: prune(user.losses),
			rainbowWins: prune(user.rainbowWins),
			rainbowLosses: prune(user.rainbowLosses),
			isPrivate: prune(user.isPrivate),
			staffDisableVisibleElo: prune(user.staffDisableVisibleElo),
			staffDisableStaffColor: prune(user.staffDisableStaffColor),

			// Tournaments are disabled, no point sending this.
			// tournyWins: user.tournyWins,

			// Blacklists are sent in the sendUserGameSettings event.
			// blacklist: user.blacklist,
			customCardback: user.customCardback,
			customCardbackUid: user.customCardbackUid,
			eloOverall: user.eloOverall ? Math.floor(user.eloOverall) : undefined,
			eloSeason: user.eloSeason ? Math.floor(user.eloSeason) : undefined,
			status: user.status && user.status.type && user.status.type != 'none' ? user.status : undefined,
			winsSeason: prune(user[`winsSeason${CURRENTSEASONNUMBER}`]),
			lossesSeason: prune(user[`lossesSeason${CURRENTSEASONNUMBER}`]),
			rainbowWinsSeason: prune(user[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]),
			rainbowLossesSeason: prune(user[`rainbowLossesSeason${CURRENTSEASONNUMBER}`]),
			previousSeasonAward: user.previousSeasonAward,
			specialTournamentStatus: user.specialTournamentStatus,
			timeLastGameCreated: user.timeLastGameCreated,
			staffRole: prune(user.staffRole),
			staffIncognito: prune(user.staffIncognito),
			isContributor: prune(user.isContributor)
			// oldData: user
		}))
		.filter(user => isAEM || !user.staffIncognito);
};

const userListEmitter = {
	state: 0,
	send: false,
	timer: setInterval(() => {
		// 0.01s delay per user (1s per 100), always delay
		if (!userListEmitter.send) {
			userListEmitter.state = module.exports.userList.length / 10;
			return;
		}
		if (userListEmitter.state > 0) userListEmitter.state--;
		else {
			userListEmitter.send = false;
			io.sockets.emit('fetchUser'); // , {
			// 	list: module.exports.formattedUserList()
			// });
		}
	}, 100)
};

module.exports.userListEmitter = userListEmitter;

module.exports.formattedGameList = async () => {
	const keys = await games.keys();
	return keys.map(key => {
		const game = games.get(key);
		return {
			name: game.general.name,
			flag: game.general.flag,
			userNames: game.publicPlayersState.map(val => val.userName),
			customCardback: game.publicPlayersState.map(val => val.customCardback),
			customCardbackUid: game.publicPlayersState.map(val => val.customCardbackUid),
			gameStatus: game.gameState.isCompleted
				? game.gameState.isCompleted
				: game.gameState.isTracksFlipped
					? 'isStarted'
					: 'notStarted',
			seatedCount: game.publicPlayersState.length,
			gameCreatorName: game.general.gameCreatorName,
			minPlayersCount: game.general.minPlayersCount,
			maxPlayersCount: game.general.maxPlayersCount || game.general.minPlayersCount,
			excludedPlayerCount: game.general.excludedPlayerCount,
			casualGame: game.general.casualGame || undefined,
			eloMinimum: game.general.eloMinimum || undefined,
			isVerifiedOnly: game.general.isVerifiedOnly || undefined,
			isTourny: game.general.isTourny || undefined,
			timedMode: game.general.timedMode || undefined,
			flappyMode: game.general.flappyMode || undefined,
			flappyOnlyMode: game.general.flappyOnlyMode || undefined,
			tournyStatus: (() => {
				if (game.general.isTourny) {
					if (game.general.tournyInfo.queuedPlayers && game.general.tournyInfo.queuedPlayers.length) {
						return {
							queuedPlayers: game.general.tournyInfo.queuedPlayers.length
						};
					}
				}
				return undefined;
			})(),
			experiencedMode: game.general.experiencedMode || undefined,
			disableChat: game.general.disableChat || undefined,
			disableGamechat: game.general.disableGamechat || undefined,
			blindMode: game.general.blindMode || undefined,
			enactedLiberalPolicyCount: game.trackState.liberalPolicyCount,
			enactedFascistPolicyCount: game.trackState.fascistPolicyCount,
			electionCount: game.general.electionCount,
			rebalance6p: game.general.rebalance6p || undefined,
			rebalance7p: game.general.rebalance7p || undefined,
			rebalance9p: game.general.rerebalance9p || undefined,
			privateOnly: game.general.privateOnly || undefined,
			private: game.general.private || undefined,
			uid: game.general.uid,
			rainbowgame: game.general.rainbowgame || undefined,
			isCustomGame: game.customGameSettings.enabled,
			isUnlisted: game.general.unlisted || undefined
		};
	});
};

const gameListEmitter = {
	state: 0,
	send: false,
	timer: setInterval(() => {
		// 3 second delay, instant send
		if (gameListEmitter.state > 0) gameListEmitter.state--;
		else {
			if (!gameListEmitter.send) return;
			gameListEmitter.send = false;
			io.sockets.emit('gameList', module.exports.formattedGameList());
			gameListEmitter.state = 30;
		}
	}, 100)
};

module.exports.gameListEmitter = gameListEmitter;

module.exports.AEM = Account.find({ staffRole: { $exists: true, $ne: 'veteran' } });

const bypassKeys = [];

module.exports.verifyBypass = key => {
	return bypassKeys.indexOf(key) >= 0;
};

module.exports.consumeBypass = (key, user, ip) => {
	const idx = bypassKeys.indexOf(key);
	if (idx >= 0) {
		bypassKeys.splice(idx, 1);
		new ModAction({
			date: new Date(),
			modUserName: '',
			userActedOn: user,
			modNotes: `Bypass key used: ${key}`,
			ip: ip,
			actionTaken: 'bypassKeyUsed'
		}).save();
	}
};

module.exports.createNewBypass = () => {
	let key;
	do {
		key = `${Math.random()
			.toString(36)
			.substring(2)}${Math.random()
			.toString(36)
			.substring(2)}`.trim();
	} while (bypassKeys.indexOf(key) >= 0);
	bypassKeys.push(key);
	return key;
};

// There's a mountain of "new" type bans.
const unbanTime = new Date() - 64800000;
BannedIP.deleteMany({ type: 'new', bannedDate: { $lte: unbanTime } }, (err, r) => {
	if (err) throw err;
});
const banLength = {
	small: 18 * 60 * 60 * 1000, // 18 hours
	new: 18 * 60 * 60 * 1000, // 18 hours
	tiny: 1 * 60 * 60 * 1000, // 1 hour
	big: 7 * 24 * 60 * 60 * 1000 // 7 days
};

/**
 * Finds and summarises IP bans
 *
 * @param {*} address - An ip address
 * @return {Promise<{isBanned:boolean}>}
 */
module.exports.findIPBan = async (address) => {
	const disableIpBans = await module.exports.options.get('disableIPBans', false);
	return BannedIP.find({ ip: address }).then(bans => {
		const mostRecentBan = bans.sort((a, b) => b.bannedDate - a.bannedDate)[0];
		const type = mostRecentBan.type;
		const time = mostRecentBan.bannedDate.getTime() + (banLength[type] || banLength.big);

		if (time > Date.now()) {
			if (process.env.NODE_ENV === 'production' && !disableIpBans) {
				return { isBanned: true, time, type }
			} else {
				console.log(`IP ban ignored: ${IP} = ${ip.type}`);
			}
		}
		return { isBanned: false }
	});
};
