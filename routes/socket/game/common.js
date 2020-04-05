const { sendInProgressGameUpdate } = require('../util');
const _ = require('lodash');
const { groups, games } = require('../models');

const chatPlayer = (userKey, seats, blind) => ({
	text: blind ? `{${seats.indexOf(userKey) + 1}` : `${userKey} {${seats.indexOf(userKey) + 1}}`,
	type: 'player'
});
module.exports.chatPlayer = chatPlayer;

const chatText = (text) => ({
	text: text
});
module.exports.chatText = chatText;

const chatTeam = (team) => ({
	text: team === 'liberal' ? 'liberal' : 'fascist',
	type: team === 'liberal' ? 'liberal' : 'fascist'
});
module.exports.chatText = chatText;

module.exports.phaseTransition = async (gameKey, phase) => {

	switch (phase) {
		/* Transitions into the voting phase */
		case phases.VOTING:
			const { electionCount, president, pendingChancellor } = games.getState(gameKey, 'electionCount');

			await games.setState(gameKey, {
				status: `Vote on election #${electionCount} now.`,
				phase: phases.VOTING
			});

			for (const playerKey of await groups.members('players', gameKey)) {
				await groups.add('loader', playerKey, gameKey);
				await games.setCard(gameKey, playerKey, {
					displayed: true,
					flipped: false,
					front: 'ballot',
					back: {}
				});
			}

			await games.writeChannel(gameKey, channels.GAME.PLAYER, {
				timestamp: new Date(),
				chat: [
					chatText('You must vote for the election of president '),
					chatPlayer(president),
					chatText(' and chancellor '),
					chatPlayer(pendingChancellor),
					chatText('.'),
				]
			});

			await games.writeChannel(gameKey, channels.GAME.OBSERVER, {
				timestamp: new Date(),
				chat: [
					chatText('President '),
					chatPlayer(president),
					chatText(' nominates '),
					chatPlayer(pendingChancellor),
					chatText(' as chancellor.'),
				]
			});

			break;
	}
};

/**
 * @param {string} gameKey - A game cache key
 * @param {string} president - A user cache key to be the next president (optional)
 */
module.exports.startTurn = async (gameKey, president) => {

	const { vetoZone } = await games.getConfig(gameKey, 'vetoZone');
	const { fascistPlayed } = await games.getState(gameKey, 'fascistPolicyCount');

	if (fascistPlayed >= vetoZone) {
		await games.setState(gameKey, {isVetoEnabled: true})
	}

	/**
	 * @return {number} index of the president
	 */
	game.gameState.presidentIndex = (() => {
		const { presidentIndex, specialElectionFormerPresidentIndex } = game.gameState;

		/**
		 * @param {number} index - index of the current president
		 * @return {number} index of the next president
		 */
		const nextPresidentIndex = index => {
			const nextIndex = index + 1 === game.general.playerCount ? 0 : index + 1;

			if (game.publicPlayersState[nextIndex].isDead) {
				return nextPresidentIndex(nextIndex);
			} else {
				return nextIndex;
			}
		};

		if (Number.isInteger(specialElectionPresidentIndex)) {
			return specialElectionPresidentIndex;
		} else if (Number.isInteger(specialElectionFormerPresidentIndex)) {
			game.gameState.specialElectionFormerPresidentIndex = null;
			return nextPresidentIndex(specialElectionFormerPresidentIndex);
		} else {
			return nextPresidentIndex(presidentIndex);
		}
	})();

	game.private.summary = game.private.summary.nextTurn().updateLog({ presidentId: game.gameState.presidentIndex });

	const { seatedPlayers } = game.private; // eslint-disable-line one-var
	const { presidentIndex, previousElectedGovernment } = game.gameState;
	const pendingPresidentPlayer = seatedPlayers[presidentIndex];

	game.general.electionCount++;
	game.general.status = `Election #${game.general.electionCount}: president to select chancellor.`;
	if (!experiencedMode && !game.general.disableGamechat) {
		pendingPresidentPlayer.gameChats.push({
			gameChat: true,
			timestamp: new Date(),
			chat: [
				{
					text: 'You are president and must select a chancellor.'
				}
			]
		});
	}

	pendingPresidentPlayer.playersState
		.filter(
			(player, index) =>
				seatedPlayers[index] &&
				!seatedPlayers[index].isDead &&
				index !== presidentIndex &&
				(game.general.livingPlayerCount > 5 ? !previousElectedGovernment.includes(index) : previousElectedGovernment[1] !== index)
		)
		.forEach(player => {
			player.notificationStatus = 'notification';
		});

	game.publicPlayersState.forEach(player => {
		player.cardStatus.cardDisplayed = false;
		player.governmentStatus = '';
	});

	game.publicPlayersState[presidentIndex].governmentStatus = 'isPendingPresident';
	game.publicPlayersState[presidentIndex].isLoader = true;
	game.gameState.phase = 'selectingChancellor';

	if (game.general.timedMode) {
		if (game.private.timerId) {
			clearTimeout(game.private.timerId);
			game.private.timerId = null;
		}
		game.gameState.timedModeEnabled = true;
		game.private.timerId = setTimeout(
			() => {
				if (game.gameState.timedModeEnabled) {
					const chancellorIndex = _.shuffle(game.gameState.clickActionInfo[1])[0];

					selectChancellor(null, { user: pendingPresidentPlayer.userName }, game, { chancellorIndex });
				}
			},
			process.env.DEVTIMEDDELAY ? process.env.DEVTIMEDDELAY : game.general.timedMode * 1000
		);
	}

	game.gameState.clickActionInfo =
		game.general.livingPlayerCount > 5
			? [
					pendingPresidentPlayer.userName,
					seatedPlayers
						.filter((player, index) => !player.isDead && index !== presidentIndex && !previousElectedGovernment.includes(index))
						.map(el => seatedPlayers.indexOf(el))
			  ]
			: [
					pendingPresidentPlayer.userName,
					seatedPlayers
						.filter((player, index) => !player.isDead && index !== presidentIndex && previousElectedGovernment[1] !== index)
						.map(el => seatedPlayers.indexOf(el))
			  ];

	sendInProgressGameUpdate(game);
};
