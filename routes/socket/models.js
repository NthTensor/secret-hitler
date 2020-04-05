
const { CURRENTSEASONNUMBER } = require('../../src/frontend-scripts/node-constants');
const Account = require('../../models/account');
const ModAction = require('../../models/modAction');
const BannedIP = require('../../models/bannedIP');
const Mortice = require('mortice');
const _ = require('lodash');

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

/**
 * @typedef {Object} Mutex
 * @property {function(): Promise<function(): void>} writeLock
 * @property {function(): Promise<function(): void>} readLock
 */

/**
 * Creates a lock for a single key
 * @param {string} key - Key to lock
 * @return {Mutex}
 */
function acquire(key) {
	const mutex =  Mortice(key);
	return {
		async writeLock() {
			console.log(`Awaiting write lock for ${key}`);
			return mutex.writeLock().then(() => console.log(`Received write lock for ${key}`));
		},
		async readLock() {
			console.log(`Awaiting read lock for ${key}`);
			return mutex.readLock().then(() => console.log(`Received write lock for ${key}`));
		}
	};
}

/**
 * Creates a lock for every key in a list (at the same time)
 * @param {string[]} keys - A list of keys to lock
 * @return {Mutex}
 */
function acquireAll(keys) {
	const mutexes = keys.map(key => acquire(key));
	return {
		async writeLock() {
			return Promise
				.all(mutexes.map(async mutex => mutex.writeLock()))
				.then(releases => () => releases.forEach(releases => releases()));
		},
		async readLock() {
			return Promise
				.all(mutexes.map(async mutex => mutex.readLock()))
				.then(releases => () => releases.forEach(releases => releases()));
		}
	};
}

/**
 * Creates a lock for every key in a list (individually, in the order that they become available)
 * @param {string[]} keys - A list of keys to lock
 * @return {{writeLock: (function(): AsyncIterableIterator<*>), readLock: (function(): AsyncIterableIterator<*>)}}
 */
function acquireEach(keys) {
	const mutexes = keys.map(key => acquire(key));
	return {
		/**
		 * Generates write lock & key pairs
		 * @yield {Promise<{release: function(): void, key: string}>}
		 */
		async *writeLock() {
			for (let i = 0; i < keys.length; i++) {
				yield mutexes[i].writeLock().then(release => ({ key: keys[i], release }));
			}
		},
		/**
		 * Generates readLock lock & key pairs
		 * @yield {Promise<{release: function(): void, key: string}>}
		 */
		async *readLock() {
			for (let i = 0; i < keys.length; i++) {
				yield mutexes[i].readLock().then(release => ({ key: keys[i], release }));
			}
		}
	};
}

async function hset(key, props) {
	for (const [name, value] in Object.entries(props)) {
		if (Object.hasOwnProperty(name)) {
			props[name] = JSON.stringify(value);
		}
	}
	await redis.hset(key, props);
}

async function hget(key, names) {
  let results;
	if (names != null) {
		results = await redis.hset(key, names);
	} else {
		results = await redis.hgetall(key)
	}
	const props = {};
	for (const [key, value] in Object.entries(results)) {
		if (Object.hasOwnProperty(key)) {
			props[key] = JSON.parse(value);
		}
	}
	return props;
}

function applyPrefix(prefix, keys) {
	return keys.map(key => `${prefix}:${key}`);
}

module.exports.gameSets = {
	/**
	 * Adds a game to a game set.
	 *
	 * @param {string} setKey - A game set cache key
	 * @param {string} gameKey - A game cache key
	 * @return {Promise<void>}
	 */
	async add(setKey, gameKey) {
		await redis.sadd(`game+set:${setKey}`, gameKey);
	},

	/**
	 * Removes.
	 *
	 * @param {string} setKey - A game set cache key
	 * @param {string} gameKey - A game cache key
	 * @return {Promise<void>}
	 */
	async remove(setKey, gameKey) {
		await redis.srem(`game+set:${setKey}`, gameKey);
	},

	/**
	 * Gets all the gameKeys in a set
	 *
	 * @param {string} setKey - A game set cache key
	 * @return {Promise<string[]>}
	 */
	async members(setKey) {
		return redis.smembers(`game+set:${setKey}`);
	},

	/**
	 * Determine whether a game is a member of a set.
	 *
	 * @param {string} setKey - A game set cache key
	 * @param {string} gameKey - A game cache key
	 * @return {Promise<*>}
	 */
	async isMember(setKey, gameKey) {
		return redis.sismember(`game+set:${setKey}`, gameKey);
	},

	/**
	 * Gets all the gameKeys in a set and clears the set
	 *
	 * @param {string} setKey - A game set cache key
	 * @return {Promise<string[]>}
	 */
	async popAll(setKey) {
		const results = await redis.pipeline()
			.smembers(`game+set:${setKey}`)
			.del(`game+set:${setKey}`)
			.exec();
		return results[1][1];
	}
};

/**
 * Games model.
 */
module.exports.games = {
	acquire: (key) => acquire(`game:${key}`),
	acquireAll: (...keys) => acquireAll(applyPrefix('game', keys)),
	acquireEach: (...keys) => acquireEach(applyPrefix('game', keys)),

	/**
	 * Stores game state.
	 *
	 * Be sure to acquire a write lock before calling.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {Object} state - A game state object
	 * @return {Promise<void>}
	 *
	 * @example
	 *
	 *     	games.setState('gameKey', {undrawnPolicyCount: 1});
	 */
	async setState(gameKey, state) {
		await hset(`game:${gameKey}:state`, state);
	},

	/**
	 * Increments a game state field. Returns the value before tncrement.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {string} stateName - A game state key
	 * @param {number} [ammount] - The ammount to increase by
	 * @return {Promise<number>}
	 */
	async incrState(gameKey, stateName, ammount=1) {
		return redis.hincrby(`game:${gameKey}:state`, stateName, ammount);
	},

	/**
	 * Gets game state.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {...string} [names] - An optional list of state element names
	 * @return {Promise<object>}
	 *
	 * @example
	 *
	 *     	games.getState('gameKey', 'undrawnPolicyCount'});
	 */
	async getState(gameKey, ...names) {
		return hget(`game:${gameKey}:state`, names);
	},

	/**
	 * Delets keys from game state.
	 *
	 * @param {string} gameKey - A game cach key
	 * @param {...string} names - A list of state element names
	 * @return {Promise<void>}
	 */
	async deleteState(gameKey, ...names) {
		await redis.hdel(`game:${gameKey}:state`, names);
	},

	/**
	 * Stores game configuration.
	 *
	 * Be sure to acquire a write lock before calling.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {Object} config - A game state object
	 * @return {Promise<void>}
	 */
	async setConfig(gameKey, config) {
		await hset(`game:${gameKey}:config`, config);
	},

	/**
	 * Gets game configuration.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {...string} [names] - An optional list of config element names
	 */
	async getConfig(gameKey, names) {
		return hget(`game:${gameKey}:config`, names);
	},

	/**
	 * Deletes part of a game configuration.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {...string} names - A list of config element names
	 * @return {Promise<void>}
	 */
	async deleteConfig(gameKey, ...names) {
		await redis.hdel(`game:${gameKey}:config`, names);
	},

	/**
	 * Push a new chat onto a chatroom channel
	 *
	 * When I was first implementing this, I first tried making one chat list for each game.
	 * But that didn't work, because games are actually built on a collection of loosely
	 * related chat rooms, each with it's own complex read/write authorization and purpose.
	 *
	 * To better model this, I have introduced the idea of 'chat channels'. Each chat must be
	 * published to exactly one channel. You can later get the chat history for this channel
	 * by passing the same channelKey to `chatGet`. You can also pass a list of channelKeys
	 * to `chatGet` to get the combined history of all the channels.
	 *
	 * [Note 1]: Chat objects are intended to be serialized into strings once, and then never
	 *           decentralized. Do not call JSON.parse on these.
	 *
	 * [Note 2]: Channels are supposed to give a nice seperation of concerns -- You should
	 *           implement game logic ontop of them, not here. I suggest giving a each
	 *           player a channel, based on their userKey -- and also having a seperate
	 *           channel for game status updates, for moderators, for observers and so on.
	 *
	 * [Note 3]: You do not need to lock a game to push chat.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {string} channelKey - A channel cache key
	 * @param {Object|Object[]} chats - A chat object or array of chat objects
	 * @return {Promise<void>}
	 */
	async writeChannel(gameKey, channelKey, chats) {
		if (Array.isArray(chats)) {
			await redis.pipeline()
				.sadd(`game:${gameKey}:channels`, channelKey)
				.rpush(`game:${gameKey}:chat:${channelKey}`, chats.map(chat => JSON.stringify(chat)))
				.exec();
		} else {
			await redis
				.sadd(`game:${gameKey}:channels`, channelKey)
				.rpush(`game:${gameKey}:chat:${channelKey}`, JSON.stringify(chats))
				.exec();
		}
	},

	/**
	 * Retrieves an entire chat log for a game.
	 *
	 * @param {string} gameKey - A game cache key
	 * @param {string|string[]} channelKeys - One or more channel cache keys
	 * @return {Promise<string[]>}
	 */
	async readChannels(gameKey, channelKeys) {
		if (Array.isArray(channelKeys)) {
			chats = [];
			let pipeline = redis.pipeline();
			for (const channelKey of channelKeys) {
				pipeline = pipeline.lrange(`game:${gameKey}:chat:${channelKey}`, 0 -1);
			}
			return pipeline.exec()
				.then(results => results.reduce((acc, val) => { (val[0] !== null) ? [...acc, ...val[1]] : acc }, [] ));
		} else {
			return redis.get(`game:${gameKey}:chat:${channelKeys}`);
		}
	},

	async setCard(gameKey, userKey, card) {
		await redis.hset(`game:${gameKey}:card`, userKey, JSON.stringify(card));
	},

	async getCards(gameKey) {
		return hget(`game:${gameKey}:card`, null);
	},

	async remove(gameKey) {
		const channels = await redis.smembers(`game:${gameKey}:channels`)
			.then(channelKeys => `game:${gameKey}:chat:${channelKey}`);
		await redis.del(`game:${gameKey}:state`, `game:${gameKey}:config`, `game:${gameKey}:card`, ...channels);
	},
};

module.exports.stages = {
	SETUP: 'setup',
	STARTING: 'starting',
	PLAYING: 'playing',
	ENDED: 'ended',
	ERROR: 'error',
	REMADE: 'remade'
};

module.exports.phases = {
	VOTING: 'voting',
	SELECTING_CHANCELLOR: 'selectingChancellor',
	CHANCELLOR_VOTE_ON_VETO: 'chancellorVoteOnVeto',
	PRESIDENT_VOTE_ON_VETO: 'presidentVoteOnVeto',
	ENACT_POLICY: 'enactPolicy',
	POWERS: 'powers',
};

module.exports.channels = {
	GAME: {
		PUBLIC: "game:public",
		PLAYER: "game:player",
		HITLER: "game:hitler",
		LIBERAL: "game:liberal",
		FASCIST: "game:fasscist",
		OBSERVER: 'game:observer'
	},
	STAFF: 'staff',
	DEBUG: 'debug',
	CHAT: {
		PLAYER: 'chat:player',
		OBSERVER: 'chat:observer'
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
	 * @param {string} userKey - A user cache key
	 * @param {string} [gameKey] - An optional game cache key
	 * @return {Promise<void>}
	 */
	async add(groupKey, userKey, gameKey) {
		if (gameKey != null) {
			await redis
				.multi()
				.sadd(`game:${gameKey}:groups`, groupKey)
				.sadd(`game:${gameKey}:group:${groupKey}`, userKey)
				.sadd(`game:${gameKey}:rgroup:${userKey}`, groupKey)
				.exec();
		} else {
			await redis
				.multi()
				.sadd(`group:${groupKey}`, userKey)
				.sadd(`rgroup:${userKey}`, groupKey)
				.exec();
		}
	},

	/**
	 * Remove users from a group.
	 *
	 * @param {string} groupKey - A group cache key
	 * @param {string} userKeys - One or more user cache keys
	 * @param {string} [gameKey] - An optional game cache key
	 * @return {Promise<void>}
	 */
	async remove(groupKey, userKeys, gameKey) {
		if (gameKey != null) {
			await redis
				.multi()
				.srem(`game:${gameKey}:group:${groupKey}`, userKeys)
				.srem(`game:${gameKey}:rgroup${userKeys}`, groupKey)
				.exec();
		} else {
			await redis
				.multi()
				.srem(`group:${groupKey}`, userKeys)
				.srem(`rgroup:${userKeys}`, groupKey)
				.exec();
		}
	},

	/**
	 * List all members of a group.
	 *
	 * @param {string} groupKey - A group cache key
	 * @param {string} [gameKey] - A game cache key
	 * @return {Promise<string[]>}
	 */
	async members(groupKey, gameKey) {
		if (gameKey != null) {
			return redis.smembers(`game:${gameKey}:group:${groupKey}`);
		} else {
			return redis.smembers(`group:${groupKey}`);
		}
	},

	/**
	 * List all groups of a member.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {string} [gameKey] - A game cache key
	 * @return {Promise<String[]>}
	 */
	async ofMember(userKey, gameKey) {
		if (gameKey != null) {
			return redis.smembers(`game:${gameKey}:rgroup:${userKeys}`);
		} else {
			return redis.smembers(`rgroup:${userKey}`);
		}
	},

	/**
	 * Determine whether a user is a member of a group.
	 *
	 * @param {string} groupKey - A group cache key
	 * @param {string} userKey - A user cache key
	 * @param {string} [gameKey] - An optional game cache key
	 * @return {Promise<boolean>}
	 */
	async isMember(groupKey, userKey, gameKey) {
		if (gameKey != null) {
			return redis.sismember(`game:${gameKey}:group:${groupKey}`, userKey);
		} else {
			return redis.sismember(`group:${groupKey}`, userKey);
		}
	},

	/**
	 * Return the number of members in a group.
	 *
	 * @param {string} groupKey
	 * @param {string} gameKey
	 * @return {Promise<number>}
	 */
	async count(groupKey, gameKey) {
		if (gameKey != null) {
			return redis.scard(`game:${gameKey}:group:${groupKey}`);
		} else {
			return redis.scard(`group:${groupKey}`);
		}
	},

	/**
	 * Removes a user from all groups (game groups or otherwise).
	 * Note: Try not to run this too often.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {string} [gameKey] - An optional user cache key
	 * @return {Promise<void>}
	 */
	async removeFromAll(userKey, gameKey) {
		if (gameKey != null) {
			const groupKeys = await redis.smembers(`game:${gameKey}:rgroup:${userKey}`);
			let pipeline = redis.pipeline().del(`game:${gameKey}:rgroup:${userKey}`);
			for (const groupKey of groupKeys) {
				pipeline = pipeline.srem(`game:${gameKey}:group:${groupKey}`, userKey);
			}
			await pipeline.exec();
		} else {
			const groupKeys = await redis.smembers(`rgroup:${userKey}`);
			let pipeline = redis.pipeline().del(`rgroup:${userKey}`);
			for (const groupKey of groupKeys) {
				pipeline = pipeline.srem(`group:${groupKey}`, userKey);
			}
			await pipeline.exec();
		}
	},

	/**
	 * Removes all users from a group.
	 * @param {string} groupKey - A group cache key
	 * @param {string} [gameKey] - An optional game cache key
	 * @return {Promise<void>}
	 */
	async empty(groupKey, gameKey) {
		if (gameKey != null) {
			const userKeys = await redis.smembers(`game:${gameKey}:group:${groupKey}`);
			let pipeline = redis.pipeline().del(`game:${gameKey}:group:${groupKey}`);
			for (const userKey of userKeys) {
				pipeline = pipeline.srem(`game:${gameKey}:rgroup:${userKey}`, groupKey);
			}
			await pipeline.exec();
		} else {
			const userKeys = await redis.smembers(`group:${groupKey}`);
			let pipeline = redis.pipeline().del(`group:${groupKey}`);
			for (const userKey of userKeys) {
				pipeline = pipeline.srem(`rgroup:${userKey}`, groupKey);
			}
			await pipeline.exec();
		}
	},

	/**
	 * Clears all groups of a game.
	 *
	 * @param {string} gameKey
	 * @return {Promise<void>} - A game cache key
	 */
	async emptyAll(gameKey) {
		if (gameKey != null) {
			await redis.smembers(`game:${gameKey}:groups`)
				.then(groupKeys => redis.del(groupKeys));
		}
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
	acquire: (key) => acquire(`user+info:${key}`),
	acquireAll: (...keys) => acquireAll(applyPrefix('user+info', keys)),
	acquireEach: (...keys) => acquireEach(applyPrefix('user+info', keys)),

	/**
	 * Sets user properties.
	 * Note: You should acquire a lock before calling this.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {object|string} info - Either a properties object or the name of a property
	 * @param {*} [value] - If info is the name of a property, then this is it's value
	 * @return {Promise<void>}
	 *
	 * @example
	 *
	 *     	userInfo.set('key', 'prop', 'value);
	 *      userInfo.set('key', {prop1: 'one', prop2: 2});
	 */
	async set(userKey, info, value) {
		let peroperties = {};

		if (typeof info == 'string') {
			peroperties[info] = value;
		} else {
			peroperties = info;
		}

		for (const property in peroperties) {
			if (peroperties.hasOwnProperty(property)) {
				peroperties[property] = JSON.stringify(peroperties[property])
			}
		}

		await redis.hset(`user+info:${userKey}`, peroperties);
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
	async get(userKey, ...info) {
		if (info != null && 'length' in info && info.length !== 0) {
			const properties = await redis.hmget(`user+info:${userKey}`, info)
				.then(props => props.map(JSON.parse));
			return _.zipObject(info, properties);
		} else {
			const properties = await redis.hgetall(`user+info:${userKey}`);
			for (const property in properties) {
				if (properties.hasOwnProperty(property)) {
					if (properties[property] != null && properties[property] !== '') {
						properties[property] = JSON.parse(properties[property]);
					}
				}
			}
			return properties;
		}
	},

	/**
	 * Deletes a user property.
	 *
	 * @param {string} userKey - A user cache key
	 * @param {string} prop - A user info property
	 * @return {Promise<void>}
	 */
	async delete(userKey, prop) {
		await redis.hdel(`user+info:${userKey}`, prop);
	}
};

const serverStateDate = new Date();

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
				.set(`gen+chat+time`, new Date().toJSON())
				.exec();
		} else {
			await redis
				.pipeline()
				.rpush(`gen+chat`, JSON.stringify(chats))
				.ltrim(`gen+chat`, -99, -1)
				.set(`gen+chat+time`, new Date().toJSON())
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
	 * Retrieves all gen-chat.
	 * Note: Returns a formatted json string, ready for sending to clients.
	 *
	 * @return {Promise<string>}
	 */
	async get() {
		return redis
			.multi()
			.get(`sticky`)
			.lrange(`gen+chat`, 0, 100)
			.exec()
			.then(results => {
				return `{"sticky":"${results[0][1] || ""}","list":[${(results[1][1] || []).join(',')}]}`
			});
	},

	/**
	 * Sets chat sticky.
	 *
	 * @param {string} msg - A message to sticky
	 * @return {Promise<void>}
	 */
	async stick(msg) {
		await redis.set('sticky', msg);
	},

	/**
	 * Returns the time since the last chat message was posted.
	 * If there is no previous message, returns time since start.
	 *
	 * @return {Date}
	 */
	async timeSinceLast() {
		const curTime = new Date();
		const jsonDate = await redis.get(`gen+chat+time`);
		if (jsonDate != null) {
			return curTime - new Date(jsonDate);
		} else {
			return curTime - serverStateDate;
		}
	}
};

/**
 * Options model.
 * Store global boolean options here.
 */
module.exports.options = {
	acquire: (key) => acquire(`opt:${key}`),
	acquireAll: (...keys) => acquireAll(applyPrefix('opt', keys)),
	acquireEach: (...keys) => acquireEach(applyPrefix('opt', keys)),

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


/**
 * Standard AEM group lookup
 *
 * @param {string} userKey - A user cache key
 * @return {Promise<boolean>}
 */
module.exports.isStandardAEM = async userKey => {
	return await module.exports.groups.authorize(userKey, {
		any: ['admin', 'editor', 'moderator'],
		none: ['trialmod', 'altmod', 'veteran']
	});
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
module.exports.testIP = async (IP, callback) => {
	const ipbansNotEnforced = await module.exports.options.get('ipbansNotEnforced', false);
	if (!IP) callback('Bad IP!');
	else if (ipbansNotEnforced) callback(null);
	else {
		BannedIP.find({ ip: IP }, (err, ips) => {
			if (err) callback(err);
			else {
				let date;
				let unbannedTime;
				const ip = ips.sort((a, b) => b.bannedDate - a.bannedDate)[0];

				if (ip) {
					date = Date.now();
					unbannedTime = ip.bannedDate.getTime() + (banLength[ip.type] || banLength.big);
				}

				if (ip && unbannedTime > date) {
					if (process.env.NODE_ENV === 'production') {
						callback(ip.type, unbannedTime);
					} else {
						console.log(`IP ban ignored: ${IP} = ${ip.type}`);
						callback(null);
					}
				} else {
					callback(null);
				}
			}
		});
	}
};