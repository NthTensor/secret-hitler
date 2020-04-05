const { sendInProgressGameUpdate, sendInProgressModChatUpdate } = require('../util');
const { phaseTransition, startElection, shufflePolicies, chatPlayer, chatText, chatTeam } = require('./common');
const {
	specialElection,
	policyPeek,
	investigateLoyalty,
	executePlayer,
	selectPolicies,
	selectPlayerToExecute,
	selectPartyMembershipInvestigate,
	selectSpecialElection,
	showPlayerLoyalty,
	policyPeekAndDrop
} = require('./policy-powers');
const { completeGame } = require('./end-game');
const _ = require('lodash');
const { makeReport } = require('../report.js');
const { groups, games } = require('../models');

const powerMapping = {
	investigate: [investigateLoyalty, 'The president must investigate the party membership of another player.'],
	deckpeek: [policyPeek, 'The president must examine the top 3 policies.'],
	election: [specialElection, 'The president must select a player for a special election.'],
	bullet: [executePlayer, 'The president must select a player for execution.'],
	reverseinv: [showPlayerLoyalty, 'The president must reveal their party membership to another player.'],
	peekdrop: [policyPeekAndDrop, 'The president must examine the top policy, and may discard it.']
};

/**
 * @param {object} socket - socket reference
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {object} data - from socket emit
 * @param {bool} force - whether or not this action was forced
 */
module.exports.selectChancellor = async (socket, userKey, gameKey, data, force = false) => {

	const numPlayers = await groups.count('players', gameKey);

	if (data.chancellorIndex >= numPlayers || data.chancellorIndex < 0) {
		return;
	}

	if (!force && await gameSets.isMember('frozen', gameKey)) {
		if (socket) {
			socket.emit('sendAlert', 'An AEM member has prevented this game from proceeding. Please wait.');
		}
		return;
	}

	const release = await games.acquire(gameKey);
	const numDead = await groups.count('dead', gameKey);
	const { phase, seats, president, previousChancellor, previousPresident } =
		await games.getState(gameKey, 'phase', 'seats', 'president', 'previousChancellor', 'previousPresident', 'electionCount');
	const pendingChancellor = seats[data.chancellorIndex];

	if (
		phase === phases.SELECTING_CHANCELLOR
		&& !await groups.isMember('dead', pendingChancellor, gameKey)
		&& userKey === president
		&& pendingChancellor !== president
		&& pendingChancellor !== previousChancellor
		&& (pendingChancellor !== previousPresident || numPlayers - numDead <= 5)
	) {
		await games.setState(gameKey, { pendingChancellor }).then(release);
	} else {
		release();
	}
};

/**
 * Enacts all policies in *Hand of gameKey.
 *
 * @param {string} gameKey - A game cache key.
 */
const enactPolicy = async (gameKey) => {

	await games.setState(gameKey, {
		status: `A policy is being enacted.`,
		phase: phases.ENACT_POLICY
	});
	const { fascistHand, liberalHand } = await games.getState(gameKey, 'fascistHand', 'liberalHand');

	await games.incrState(gameKey, 'fascistPlayed', fascistHand);
	await games.incrState(gameKey, 'liberalPlayed', liberalHand);
};

/**
 * Sample random card draws with a hypergeometric distribution.
 * Moves cards from *Deck and *Discard to *Hand in game state.
 *
 * @param {string} gameKey - A game cache key
 * @param {number} [numToDraw] - The number of keys to draw
 */
const drawCards = async (gameKey, numToDraw = 1) => {
	const { fascistDeck, liberalDeck, fascistDiscard, liberalDiscard } = await games.getState(gameKey);
	const deck = fascistDeck + liberalDeck;

	if (deck < numToDraw) {
		/* Merge the discard and re-draw */
		await games.setState(gameKey, {
			fascistDeck: fascistDeck + fascistDiscard,
			liberalDeck: liberalDeck + liberalDiscard,
			fascistDiscard: 0,
			liberalDiscard: 0
		});

	}

	if (numToDraw === 1) {
		const team = _.sample(['fascist', 'liberal']);
		await games.incrState(gameKey, `${team}Deck`, -1);
		await games.incrState(gameKey, `${team}Hand`, 1);
	} else {
		for (let i = 0; i < numToDraw; i++) {
			await drawCards(gameKey);
		}
	}
};

/**
 * @param {object} socket
 * @param {string} userKey
 * @param {string} gameKey
 * @param {object} data
 */
const selectPresidentVoteOnVeto = async (socket, userKey, gameKey, data) => {

	if (await gameSets.isMember('frozen', gameKey)) {
		if (socket) {
			socket.emit('sendAlert', 'An AEM member has prevented this game from proceeding. Please wait.');
		}
		return;
	}

	const { stage, president, seats } = await games.getState(gameKey, 'stage', 'president', 'seats');

	if (
		stage === stages.PLAYING
		&& president === userKey
	) {
		await games.setCard(gameKey, userKey, {
			displayed: true,
			front: 'ballot',
			back: {
				name: data.vote ? 'ja' : 'nein'
			}
		});
		await games.writeChannel(gameKey, channels.GAME.PUBLIC, {
			timestamp: new Date(),
			chat: [
				chatText('President '),
				chatPlayer(president, seats),
				chatText(data.vote ? ' has voted to veto this election.' : ' has voted not to veto this election.')
			]
		});
		if (data.vote) {
			/* The president voted to veto */
			const numElectionTracker = await games.incrState(gameKey, 'electionTrackerCount');
			await games.writeChannel(gameKey, channels.GAME.PUBLIC, {
				timestamp: new Date(),
				chat: [
					chatText(`The President and Chancellor have voted to veto this election and the election tracker moves forward. (${numElectionTracker + 1}/3)`)
				]
			});
		} else {
			/* The veto fails, draw a random card to the hand, then play it. */
			await drawCards(gameKey, 1);
			await enactPolicy(gameKey);
			await phaseTransition(gameKey);
		}
	}


	if (
		!game.private.lock.selectPresidentVoteOnVeto &&
		Number.isInteger(chancellorIndex) &&
		game.publicPlayersState[chancellorIndex] &&
		president.cardFlingerState &&
		president.cardFlingerState[0]
	) {

		setTimeout(
			() => {

				if (data.vote) {


					setTimeout(
						() => {
							game.gameState.audioCue = '';
							president.cardFlingerState = [];
							if (game.trackState.electionTrackerCount <= 2 && game.publicPlayersState.findIndex(player => player.governmentStatus === 'isChancellor') > -1) {
								game.publicPlayersState.forEach(player => {
									if (player.previousGovernmentStatus) {
										player.previousGovernmentStatus = '';
									}
								});
								game.publicPlayersState[game.gameState.presidentIndex].previousGovernmentStatus = 'wasPresident';
								game.publicPlayersState[chancellorIndex].previousGovernmentStatus = 'wasChancellor';
							}
							if (game.trackState.electionTrackerCount >= 3) {
								if (!game.gameState.undrawnPolicyCount) {
									shufflePolicies(game);
								}

								enactPolicy(game, game.private.policies.shift(), socket);
								game.gameState.undrawnPolicyCount--;
								if (game.gameState.undrawnPolicyCount < 3) {
									shufflePolicies(game);
								}
							} else {
								startElection(game);
							}
						},
						process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 1000 : 3000
					);
				} else {
					game.gameState.audioCue = 'failedVeto';
					sendInProgressGameUpdate(game);
					setTimeout(
						() => {
							game.gameState.audioCue = '';
							publicPresident.cardStatus.cardDisplayed = false;
							publicChancellor.cardStatus.cardDisplayed = false;
							president.cardFlingerState = [];
							enactPolicy(game, game.private.currentElectionPolicies[0], socket);
							setTimeout(() => {
								publicChancellor.cardStatus.isFlipped = publicPresident.cardStatus.isFlipped = false;
							}, 1000);
						},
						process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 1000 : 2000
					);
				}
			},
			process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 500 : 2000
		);
	}
};

module.exports.selectPresidentVoteOnVeto = selectPresidentVoteOnVeto;

/**
 * @param {Object} socket - Socket reference
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {Object} data - Message payload
 */
const selectChancellorVoteOnVeto = async (socket, userKey, gameKey, data) => {

	if (gameSets.isMember('frozen', gameKey)) {
		if (socket) {
			socket.emit('sendAlert', 'An AEM member has prevented this game from proceeding. Please wait.');
		}
		return;
	}

	const { seats, stage, phase, chancellor } = await games.getState(gameKey, 'seats', 'stage', 'phase');

	if (
		stage === stages.PLAYING
		&& phase === phases.CHANCELLOR_VOTE_ON_VETO
		&& userKey === chancellor
	) {
		await groups.remove('loader', userKey, gameKey);

		await games.setCard(gameKey, userKey, {
			displayed: true,
			front: 'ballot',
			back: {
				name: data.vote ? 'ja' : 'nein'
			}
		});

		await games.writeChannel(gameKey, channels.GAME.PUBLIC, {
			timestamp: new Date(),
			chat: [
				{ text: 'Chancellor ' },
				{
					text: game.general.blindMode ? `{${seats.indexOf(userKey) + 1}}` : `${userKey} {${seats.indexOf(userKey) + 1}}`,
					type: 'player'
				},
				{
					text: data.vote ? ' has voted to veto this election.' : ' has voted not to veto this election.'
				}
			]
		});

		if (data.vote) {
			/* They voted ja; the veto continues to the president */
			await phaseTransition(phases.PRESIDENT_VOTE_ON_VETO);
		} else {
			/* The veto fails */
		}
	}
};

module.exports.selectChancellorVoteOnVeto = selectChancellorVoteOnVeto;

// todo check this argument for jsdoc
const handToLog = hand =>
	hand.reduce(
		(hand, policy) => {
			return policy === 'fascist' ? Object.assign({}, hand, { reds: hand.reds + 1 }) : Object.assign({}, hand, { blues: hand.blues + 1 });
		},
		{ reds: 0, blues: 0 }
	);

/**
 * @param {object} passport - socket authentication.
 * @param {object} game - target game.
 * @param {object} data - socket emit
 * @param {boolean} wasTimer - came from timer
 * @param {object} socket - socket
 */
const selectChancellorPolicy = (passport, game, data, wasTimer, socket) => {
	const { experiencedMode } = game.general;
	const presidentIndex = game.publicPlayersState.findIndex(player => player.governmentStatus === 'isPresident');
	const president = game.private.seatedPlayers[presidentIndex];
	const chancellorIndex = game.publicPlayersState.findIndex(player => player.governmentStatus === 'isChancellor');
	const chancellor = game.private.seatedPlayers[chancellorIndex];
	const enactedPolicy = game.private.currentChancellorOptions[data.selection === 3 ? 1 : 0];

	if (game.gameState.isGameFrozen) {
		if (socket) {
			socket.emit('sendAlert', 'An AEM member has prevented this game from proceeding. Please wait.');
		}
		return;
	}

	if (game.general.isRemade) {
		if (socket) {
			socket.emit('sendAlert', 'This game has been remade and is now no longer playable.');
		}
		return;
	}

	if (!chancellor || chancellor.userName !== passport.user) {
		return;
	}

	if (
		!game.private.lock.selectChancellorPolicy &&
		chancellor &&
		chancellor.cardFlingerState &&
		chancellor.cardFlingerState.length
	) {
		if (!wasTimer && !game.general.private) {
			if (
				chancellor.role.team === 'liberal' &&
				enactedPolicy === 'fascist' &&
				(game.private.currentChancellorOptions[0] === 'liberal' || game.private.currentChancellorOptions[1] === 'liberal')
			) {
				// Liberal chancellor chose to play fascist, probably throwing.
				makeReport(
					{
						player: chancellor.userName,
						seat: chancellorIndex + 1,
						role: 'Liberal',
						situation: `was given choice as chancellor, and played fascist.`,
						election: game.general.electionCount,
						title: game.general.name,
						uid: game.general.uid,
						gameType: game.general.casualGame ? 'Casual' : 'Ranked'
					},
					game,
					'report'
				);
			}
			if (
				chancellor.role.team === 'fascist' &&
				enactedPolicy === 'liberal' &&
				game.trackState.liberalPolicyCount >= 4 &&
				(game.private.currentChancellorOptions[0] === 'fascist' || game.private.currentChancellorOptions[1] === 'fascist')
			) {
				// Fascist chancellor chose to play 5th liberal.
				makeReport(
					{
						player: chancellor.userName,
						seat: chancellorIndex + 1,
						role: 'Fascist',
						situation: `was given choice as chancellor with 4 blues on the track, and played liberal.`,
						election: game.general.electionCount,
						title: game.general.name,
						uid: game.general.uid,
						gameType: game.general.casualGame ? 'Casual' : 'Ranked'
					},
					game,
					'report'
				);
			}
		}

		const modOnlyChat = {
			timestamp: new Date(),
			gameChat: true,
			chat: [
				{
					text: 'Chancellor '
				},
				{
					text: `${chancellor.userName} {${chancellorIndex + 1}}`,
					type: 'player'
				},
				{
					text: wasTimer ? ' has automatically chosen to play a ' : ' has chosen to play a '
				},
				{
					text: enactedPolicy,
					type: enactedPolicy
				},
				{
					text: wasTimer ? 'policy due to the timer expiring.' : ' policy.'
				}
			]
		};
		game.private.hiddenInfoChat.push(modOnlyChat);
		sendInProgressModChatUpdate(game, modOnlyChat);

		game.private.lock.selectPresidentPolicy = false;

		if (game.general.timedMode && game.private.timerId) {
			clearTimeout(game.private.timerId);
			game.private.timerId = null;
			game.gameState.timedModeEnabled = false;
		}

		game.private.lock.selectChancellorPolicy = true;

		if (data.selection === 3) {
			chancellor.cardFlingerState[0].notificationStatus = '';
			chancellor.cardFlingerState[1].notificationStatus = 'selected';
		} else {
			chancellor.cardFlingerState[0].notificationStatus = 'selected';
			chancellor.cardFlingerState[1].notificationStatus = '';
		}

		game.publicPlayersState[chancellorIndex].isLoader = false;
		chancellor.cardFlingerState[0].action = chancellor.cardFlingerState[1].action = '';
		chancellor.cardFlingerState[0].cardStatus.isFlipped = chancellor.cardFlingerState[1].cardStatus.isFlipped = false;

		if (game.gameState.isVetoEnabled) {
			game.private.currentElectionPolicies = [enactedPolicy];
			game.general.status = 'Chancellor to vote on policy veto.';
			sendInProgressGameUpdate(game);

			setTimeout(
				() => {
					const chat = {
						gameChat: true,
						timestamp: new Date(),
						chat: [
							{
								text:
									'You must vote whether or not to veto these policies.  Select Ja to veto the your chosen policy or select Nein to enact your chosen policy.'
							}
						]
					};

					game.publicPlayersState[chancellorIndex].isLoader = true;

					chancellor.cardFlingerState = [
						{
							position: 'middle-left',
							notificationStatus: '',
							action: 'active',
							cardStatus: {
								isFlipped: false,
								cardFront: 'ballot',
								cardBack: 'ja'
							}
						},
						{
							position: 'middle-right',
							action: 'active',
							notificationStatus: '',
							cardStatus: {
								isFlipped: false,
								cardFront: 'ballot',
								cardBack: 'nein'
							}
						}
					];

					if (!game.general.disableGamechat) {
						chancellor.gameChats.push(chat);
					}

					sendInProgressGameUpdate(game);

					setTimeout(
						() => {
							chancellor.cardFlingerState[0].cardStatus.isFlipped = chancellor.cardFlingerState[1].cardStatus.isFlipped = true;
							chancellor.cardFlingerState[0].notificationStatus = chancellor.cardFlingerState[1].notificationStatus = 'notification';
							game.gameState.phase = 'chancellorVoteOnVeto';

							if (game.general.timedMode) {
								if (game.private.timerId) {
									clearTimeout(game.private.timerId);
									game.private.timerId = null;
								}
								game.gameState.timedModeEnabled = true;
								game.private.timerId = setTimeout(
									() => {
										if (game.gameState.timedModeEnabled) {
											game.gameState.timedModeEnabled = false;

											selectChancellorVoteOnVeto({ user: chancellor.userName }, game, { vote: Boolean(Math.floor(Math.random() * 2)) }, socket);
										}
									},
									process.env.DEVTIMEDDELAY ? process.env.DEVTIMEDDELAY : game.general.timedMode * 1000
								);
							}

							sendInProgressGameUpdate(game);
						},
						process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 500 : 1000
					);
				},
				process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 1000 : 2000
			);
		} else {
			game.private.currentElectionPolicies = [];
			game.gameState.phase = 'enactPolicy';
			sendInProgressGameUpdate(game);
			setTimeout(
				() => {
					chancellor.cardFlingerState = [];
					enactPolicy(game, enactedPolicy, socket);
				},
				experiencedMode ? 200 : 2000
			);
		}
		if (experiencedMode) {
			president.playersState[presidentIndex].claim = 'wasPresident';
			chancellor.playersState[chancellorIndex].claim = 'wasChancellor';
		} else {
			setTimeout(() => {
				president.playersState[presidentIndex].claim = 'wasPresident';
				chancellor.playersState[chancellorIndex].claim = 'wasChancellor';
				sendInProgressGameUpdate(game);
			}, 3000);
		}
	}
};

module.exports.selectChancellorPolicy = selectChancellorPolicy;

/**
 * @param {object} passport - socket authentication.
 * @param {object} game - target game.
 * @param {object} data - socket emit
 * @param {boolean} wasTimer - came from timer
 * @param {object} socket - socket
 */
const selectPresidentPolicy = (passport, game, data, wasTimer, socket) => {
	const { presidentIndex } = game.gameState;
	const president = game.private.seatedPlayers[presidentIndex];
	const chancellorIndex = game.publicPlayersState.findIndex(player => player.governmentStatus === 'isChancellor');
	const chancellor = game.private.seatedPlayers[chancellorIndex];
	const nonDiscardedPolicies = _.range(0, 3).filter(num => num !== data.selection);

	if (game.gameState.isGameFrozen) {
		if (socket) {
			socket.emit('sendAlert', 'An AEM member has prevented this game from proceeding. Please wait.');
		}
		return;
	}

	if (game.general.isRemade) {
		if (socket) {
			socket.emit('sendAlert', 'This game has been remade and is now no longer playable.');
		}
		return;
	}

	if (!president || president.userName !== passport.user || nonDiscardedPolicies.length !== 2) {
		return;
	}

	if (
		!game.private.lock.selectPresidentPolicy &&
		president &&
		president.cardFlingerState &&
		president.cardFlingerState.length &&
		Number.isInteger(chancellorIndex) &&
		game.publicPlayersState[chancellorIndex]
	) {
		if (game.general.timedMode && game.private.timerId) {
			clearTimeout(game.private.timerId);
			game.private.timerId = null;
			game.gameState.timedModeEnabled = false;
		}

		const discarded = game.private.currentElectionPolicies[data.selection];

		const modOnlyChat = {
			timestamp: new Date(),
			gameChat: true,
			chat: [
				{
					text: 'President '
				},
				{
					text: `${president.userName} {${presidentIndex + 1}}`,
					type: 'player'
				},
				{
					text: wasTimer ? ' has automatically discarded a ' : ' has chosen to discard a '
				},
				{
					text: discarded,
					type: discarded
				},
				{
					text: wasTimer ? 'policy due to the timer expiring.' : ' policy.'
				}
			]
		};
		game.private.hiddenInfoChat.push(modOnlyChat);
		sendInProgressModChatUpdate(game, modOnlyChat);

		if (!wasTimer && !game.general.private) {
			// const presGetsPower = presidentPowers[game.general.type][game.trackState.fascistPolicyCount] ? true : false;
			const track4blue = game.trackState.liberalPolicyCount >= 4;
			const trackReds = game.trackState.fascistPolicyCount;

			const passed = [game.private.currentElectionPolicies[nonDiscardedPolicies[0]], game.private.currentElectionPolicies[nonDiscardedPolicies[1]]];
			let passedNicer = '';
			if (passed[0] === 'liberal') {
				if (passed[1] === 'liberal') passedNicer = 'BB';
				else passedNicer = 'BR';
			} else if (passed[1] === 'liberal') passedNicer = 'BR';
			else passedNicer = 'RR';

			if (president.role.team === 'liberal') {
				// liberal
				if (discarded === 'liberal') {
					if (track4blue) {
						if (passedNicer === 'RR') {
							// tossed only blue on 4 blues
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Liberal',
									situation: `got BRR with 4 blues on the track, and tossed the blue.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						} else if (passedNicer === 'BR') {
							// did not force 5th blue
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Liberal',
									situation: `got BBR with 4 blues on the track, and did not force.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						}
					} else if (trackReds < 3) {
						if (passedNicer === 'RR') {
							// tossed only blue with no benefit
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Liberal',
									situation: `got BRR before HZ, and tossed the blue.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						}
					} else if (trackReds === 5) {
						if (passedNicer === 'RR') {
							// tossed blue in VZ
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Liberal',
									situation: `got BRR during veto zone, and tossed the blue.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						} else if (passedNicer === 'BR' && track4blue) {
							// tossed blue in VZ
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Liberal',
									situation: `got BBR during veto zone, and did not force 5th blue.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						}
					}
				}
			} else {
				// fascist
				if (discarded === 'fascist') {
					if (track4blue) {
						if (passedNicer === 'BB' && chancellor.role.team !== 'liberal') {
							// forced 5th blue on another fas
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Fascist',
									situation: `got BBR with 4 blues on the track, and forced blues on a fascist chancellor.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						} else if (passedNicer === 'BR' && chancellor.role.team === 'liberal') {
							// offered 5th blue choice as fas
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Fascist',
									situation: `got BRR with 4 blues on the track, and offered choice to a liberal chancellor.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						}
					} else if (trackReds === 5) {
						if (passedNicer === 'BB' && chancellor.role.team !== 'liberal') {
							// forced 5th blue as hit
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Fascist',
									situation: `got BBR with 5 reds on the track, and forced blues on a fascist chancellor.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						} else if (passedNicer === 'BR' && chancellor.role.team === 'liberal') {
							// offered 5th blue choice as hit
							makeReport(
								{
									player: president.userName,
									seat: presidentIndex + 1,
									role: 'Fascist',
									situation: `got BRR with 5 reds on the track, and offered choice to a liberal chancellor.`,
									election: game.general.electionCount,
									title: game.general.name,
									uid: game.general.uid,
									gameType: game.general.casualGame ? 'Casual' : 'Ranked'
								},
								game,
								'report'
							);
						}
					}
				}
			}
		}

		game.private.lock.selectPresidentPolicy = true;
		game.publicPlayersState[presidentIndex].isLoader = false;
		game.publicPlayersState[chancellorIndex].isLoader = true;

		try {
			if (data.selection === 0) {
				president.cardFlingerState[0].notificationStatus = 'selected';
				president.cardFlingerState[1].notificationStatus = president.cardFlingerState[2].notificationStatus = '';
			} else if (data.selection === 1) {
				president.cardFlingerState[0].notificationStatus = president.cardFlingerState[2].notificationStatus = '';
				president.cardFlingerState[1].notificationStatus = 'selected';
			} else {
				president.cardFlingerState[0].notificationStatus = president.cardFlingerState[1].notificationStatus = '';
				president.cardFlingerState[2].notificationStatus = 'selected';
			}
		} catch (error) {
			console.log(error, 'caught exception in president cardflinger');
			return;
		}

		game.private.summary = game.private.summary.updateLog({
			chancellorHand: handToLog(game.private.currentElectionPolicies.filter((p, i) => i !== data.selection))
		});
		game.private.currentChancellorOptions = [
			game.private.currentElectionPolicies[nonDiscardedPolicies[0]],
			game.private.currentElectionPolicies[nonDiscardedPolicies[1]]
		];

		president.cardFlingerState[0].action = president.cardFlingerState[1].action = president.cardFlingerState[2].action = '';
		president.cardFlingerState[0].cardStatus.isFlipped = president.cardFlingerState[1].cardStatus.isFlipped = president.cardFlingerState[2].cardStatus.isFlipped = false;

		chancellor.cardFlingerState = [
			{
				position: 'middle-left',
				action: 'active',
				cardStatus: {
					isFlipped: false,
					cardFront: 'policy',
					cardBack: `${game.private.currentElectionPolicies[nonDiscardedPolicies[0]]}p`
				}
			},
			{
				position: 'middle-right',
				action: 'active',
				cardStatus: {
					isFlipped: false,
					cardFront: 'policy',
					cardBack: `${game.private.currentElectionPolicies[nonDiscardedPolicies[1]]}p`
				}
			}
		];

		game.general.status = 'Waiting on chancellor enactment.';
		game.gameState.phase = 'chancellorSelectingPolicy';

		if (!game.general.experiencedMode && !game.general.disableGamechat) {
			chancellor.gameChats.push({
				timestamp: new Date(),
				gameChat: true,
				chat: [{ text: 'As chancellor, you must select a policy to enact.' }]
			});
		}

		sendInProgressGameUpdate(game);

		setTimeout(
			() => {
				president.cardFlingerState = [];
				chancellor.cardFlingerState.forEach(cardFlinger => {
					cardFlinger.cardStatus.isFlipped = true;
				});
				chancellor.cardFlingerState.forEach(cardFlinger => {
					cardFlinger.notificationStatus = 'notification';
				});

				if (game.general.timedMode) {
					if (game.private.timerId) {
						clearTimeout(game.private.timerId);
						game.private.timerId = null;
					}
					game.gameState.timedModeEnabled = true;
					game.private.timerId = setTimeout(
						() => {
							if (game.gameState.timedModeEnabled) {
								const isRightPolicy = Boolean(Math.floor(Math.random() * 2));

								selectChancellorPolicy({ user: chancellor.userName }, game, { selection: isRightPolicy ? 3 : 1 }, true, socket);
							}
						},
						process.env.DEVTIMEDDELAY ? process.env.DEVTIMEDDELAY : game.general.timedMode * 1000
					);
				}

				sendInProgressGameUpdate(game);
			},
			game.general.experiencedMode ? 200 : 2000
		);
	}
};

module.exports.selectPresidentPolicy = selectPresidentPolicy;

/**
 * @param {object} socket - A socket
 * @param {string} userKey - A user cache key
 * @param {string} gameKey - A game cache key
 * @param {object} data - Message payload
 * @param {bool} force - if action was forced
 */
module.exports.selectVoting = (socket, userKey, gamKeye, data, force = false) => {
	const { seatedPlayers } = game.private;
	const { experiencedMode } = game.general;
	const player = seatedPlayers.find(player => player.userName === passport.user);
	const playerIndex = seatedPlayers.findIndex(play => play.userName === passport.user);

	if (game.gameState.isGameFrozen && !force) {
		if (socket) {
			socket.emit('sendAlert', 'An AEM member has prevented this game from proceeding. Please wait.');
		}
		return;
	}

	if (game.general.isRemade && !force) {
		if (socket) {
			socket.emit('sendAlert', 'This game has been remade and is now no longer playable.');
		}
		return;
	}

	const passedElection = socket => {
		const { gameState } = game;
		const { presidentIndex } = gameState;
		const chancellorIndex = game.publicPlayersState.findIndex(player => player.governmentStatus === 'isChancellor');

		game.private._chancellorPlayerName = game.private.seatedPlayers[chancellorIndex].userName;

		if (game.gameState.previousElectedGovernment.length) {
			game.private.seatedPlayers[game.gameState.previousElectedGovernment[0]].playersState[game.gameState.previousElectedGovernment[0]].claim = '';
			game.private.seatedPlayers[game.gameState.previousElectedGovernment[1]].playersState[game.gameState.previousElectedGovernment[1]].claim = '';
			let affectedSocketId = Object.keys(io.sockets.sockets).find(
				socketId =>
					io.sockets.sockets[socketId].handshake.session.passport &&
					io.sockets.sockets[socketId].handshake.session.passport.user === game.publicPlayersState[game.gameState.previousElectedGovernment[0]].userName
			);
			if (io.sockets.sockets[affectedSocketId]) {
				io.sockets.sockets[affectedSocketId].emit('removeClaim');
			}
			affectedSocketId = Object.keys(io.sockets.sockets).find(
				socketId =>
					io.sockets.sockets[socketId].handshake.session.passport &&
					io.sockets.sockets[socketId].handshake.session.passport.user === game.publicPlayersState[game.gameState.previousElectedGovernment[1]].userName
			);
			if (io.sockets.sockets[affectedSocketId]) {
				io.sockets.sockets[affectedSocketId].emit('removeClaim');
			}
		}

		game.general.status = 'Waiting on presidential discard.';
		game.publicPlayersState[presidentIndex].isLoader = true;
		if (!experiencedMode && !game.general.disableGamechat) {
			seatedPlayers[presidentIndex].gameChats.push({
				timestamp: new Date(),
				gameChat: true,
				chat: [{ text: 'As president, you must select one policy to discard.' }]
			});
		}

		if (gameState.undrawnPolicyCount < 3) {
			shufflePolicies(game);
		}

		gameState.undrawnPolicyCount--;
		game.private.currentElectionPolicies = [game.private.policies.shift(), game.private.policies.shift(), game.private.policies.shift()];
		const verifyCorrect = policy => {
			if (policy === 'liberal') return true;
			if (policy === 'fascist') return true;
			return false;
		};
		if (
			!verifyCorrect(game.private.currentElectionPolicies[0]) ||
			!verifyCorrect(game.private.currentElectionPolicies[1]) ||
			!verifyCorrect(game.private.currentElectionPolicies[2])
		) {
			makeReport(
				{
					player: 'A Player',
					seat: presidentIndex + 1,
					role: 'Liberal',
					situation: `has just received an invalid hand!\n${JSON.stringify(game.private.currentElectionPolicies)}`,
					election: game.general.electionCount,
					title: game.general.name,
					uid: game.general.uid,
					gameType: game.general.casualGame ? 'Casual' : 'Ranked'
				},
				game,
				'report'
			);
		}

		const modOnlyChat = {
			timestamp: new Date(),
			gameChat: true,
			chat: [
				{
					text: 'President '
				},
				{
					text: `${seatedPlayers[presidentIndex].userName} {${presidentIndex + 1}}`,
					type: 'player'
				},
				{
					text: ' received '
				},
				{
					text: game.private.currentElectionPolicies[0] === 'liberal' ? 'B' : 'R',
					type: game.private.currentElectionPolicies[0]
				},
				{
					text: game.private.currentElectionPolicies[1] === 'liberal' ? 'B' : 'R',
					type: game.private.currentElectionPolicies[1]
				},
				{
					text: game.private.currentElectionPolicies[2] === 'liberal' ? 'B' : 'R',
					type: game.private.currentElectionPolicies[2]
				},
				{
					text: '.'
				}
			]
		};
		game.private.hiddenInfoChat.push(modOnlyChat);
		sendInProgressModChatUpdate(game, modOnlyChat);

		game.private.summary = game.private.summary.updateLog({
			presidentHand: handToLog(game.private.currentElectionPolicies)
		});

		seatedPlayers[presidentIndex].cardFlingerState = [
			{
				position: 'middle-far-left',
				action: 'active',
				cardStatus: {
					isFlipped: false,
					cardFront: 'policy',
					cardBack: `${game.private.currentElectionPolicies[0]}p`
				}
			},
			{
				position: 'middle-center',
				action: 'active',
				cardStatus: {
					isFlipped: false,
					cardFront: 'policy',
					cardBack: `${game.private.currentElectionPolicies[1]}p`
				}
			},
			{
				position: 'middle-far-right',
				action: 'active',
				cardStatus: {
					isFlipped: false,
					cardFront: 'policy',
					cardBack: `${game.private.currentElectionPolicies[2]}p`
				}
			}
		];
		sendInProgressGameUpdate(game);
		setTimeout(() => {
			gameState.undrawnPolicyCount--;
			sendInProgressGameUpdate(game);
		}, 200);
		setTimeout(() => {
			gameState.undrawnPolicyCount--;
			sendInProgressGameUpdate(game);
		}, 400);
		setTimeout(
			() => {
				seatedPlayers[presidentIndex].cardFlingerState[0].cardStatus.isFlipped = seatedPlayers[
					presidentIndex
				].cardFlingerState[1].cardStatus.isFlipped = seatedPlayers[presidentIndex].cardFlingerState[2].cardStatus.isFlipped = true;
				seatedPlayers[presidentIndex].cardFlingerState[0].notificationStatus = seatedPlayers[
					presidentIndex
				].cardFlingerState[1].notificationStatus = seatedPlayers[presidentIndex].cardFlingerState[2].notificationStatus = 'notification';
				gameState.phase = 'presidentSelectingPolicy';

				game.gameState.previousElectedGovernment = [presidentIndex, chancellorIndex];

				if (game.general.timedMode) {
					if (game.private.timerId) {
						clearTimeout(game.private.timerId);
						game.private.timerId = null;
					}
					game.gameState.timedModeEnabled = true;
					game.private.timerId = setTimeout(
						() => {
							if (game.gameState.timedModeEnabled) {
								game.gameState.timedModeEnabled = false;
								selectPresidentPolicy({ user: seatedPlayers[presidentIndex].userName }, game, { selection: Math.floor(Math.random() * 3) }, true, socket);
							}
						},
						process.env.DEVTIMEDDELAY ? process.env.DEVTIMEDDELAY : game.general.timedMode * 1000
					);
				}
				sendInProgressGameUpdate(game);
			},
			experiencedMode ? 200 : 600
		);
	};
	const failedElection = () => {
		game.trackState.electionTrackerCount++;

		if (game.trackState.electionTrackerCount >= 3) {
			const chat = {
				timestamp: new Date(),
				gameChat: true,
				chat: [
					{
						text: 'The third consecutive election has failed and the top policy is enacted.'
					}
				]
			};

			game.gameState.previousElectedGovernment = [];

			if (!game.general.disableGamechat) {
				game.private.seatedPlayers.forEach(player => {
					player.gameChats.push(chat);
				});

				game.private.unSeatedGameChats.push(chat);
			}

			if (!game.gameState.undrawnPolicyCount) {
				shufflePolicies(game);
			}

			game.gameState.undrawnPolicyCount--;
			setTimeout(
				() => {
					enactPolicy(game, game.private.policies.shift(), socket);
				},
				process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 500 : 2000
			);
		} else {
			if (game.general.timedMode) {
				if (game.private.timerId) {
					clearTimeout(game.private.timerId);
					game.private.timerId = null;
				}
				game.gameState.timedModeEnabled = true;
				game.private.timerId = setTimeout(
					() => {
						if (game.gameState.timedModeEnabled && game.gameState.phase === 'selectingChancellor') {
							const chancellorIndex = _.shuffle(game.gameState.clickActionInfo[1])[0];

							game.gameState.pendingChancellorIndex = null;
							game.gameState.timedModeEnabled = false;

							selectChancellor(null, { user: game.private.seatedPlayers[game.gameState.presidentIndex].userName }, game, { chancellorIndex: chancellorIndex });
						}
					},
					process.env.DEVTIMEDDELAY ? process.env.DEVTIMEDDELAY : game.general.timedMode * 1000
				);
			}

			setTimeout(
				() => {
					module.exports.startElection(game);
				},
				process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 500 : 2000
			);
		}
	};
	const flipBallotCards = socket => {
		if (!seatedPlayers[0]) {
			return;
		}
		const isConsensus = game.publicPlayersState
			.filter(player => !player.isDead)
			.every((el, i) => (seatedPlayers[i] ? seatedPlayers[i].voteStatus.didVoteYes === seatedPlayers[0].voteStatus.didVoteYes : false));

		game.publicPlayersState.forEach((player, i) => {
			if (!player.isDead && seatedPlayers[i]) {
				player.cardStatus.cardBack.cardName = seatedPlayers[i].voteStatus.didVoteYes ? 'ja' : 'nein';
				player.cardStatus.isFlipped = true;
			}
		});

		game.private.summary = game.private.summary.updateLog({
			votes: seatedPlayers.map(p => p.voteStatus.didVoteYes)
		});

		sendInProgressGameUpdate(game, true);

		setTimeout(
			() => {
				const chat = {
					timestamp: new Date(),
					gameChat: true
				};

				game.publicPlayersState.forEach((play, i) => {
					play.cardStatus.cardDisplayed = false;
				});

				setTimeout(
					() => {
						game.publicPlayersState.forEach((play, i) => {
							play.cardStatus.isFlipped = false;
						});
						sendInProgressGameUpdate(game);
					},
					process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 500 : 2000
				);

				if (seatedPlayers.filter(play => play.voteStatus.didVoteYes && !play.isDead).length / game.general.livingPlayerCount > 0.5) {
					const chancellorIndex = game.gameState.pendingChancellorIndex;
					const { presidentIndex } = game.gameState;

					game.publicPlayersState[presidentIndex].governmentStatus = 'isPresident';

					game.publicPlayersState[chancellorIndex].governmentStatus = 'isChancellor';
					chat.chat = [{ text: 'The election passes.' }];

					if (!experiencedMode && !game.general.disableGamechat) {
						seatedPlayers.forEach(player => {
							player.gameChats.push(chat);
						});

						game.private.unSeatedGameChats.push(chat);
					}

					if (
						game.trackState.fascistPolicyCount >= game.customGameSettings.hitlerZone &&
						game.private.seatedPlayers[chancellorIndex].role.cardName === 'hitler'
					) {
						const getNumberText = val => {
							if (val == 1) return '1st';
							if (val == 2) return '2nd';
							if (val == 3) return '3rd';
							return `${val}th`;
						};
						const chat = {
							timestamp: new Date(),
							gameChat: true,
							chat: [
								{
									text: 'Hitler',
									type: 'hitler'
								},
								{
									text: ` has been elected chancellor after the ${getNumberText(game.customGameSettings.hitlerZone)} fascist policy has been enacted.`
								}
							]
						};

						setTimeout(
							() => {
								game.publicPlayersState.forEach((player, i) => {
									player.cardStatus.cardFront = 'secretrole';
									player.cardStatus.cardDisplayed = true;
									player.cardStatus.cardBack = seatedPlayers[i].role;
								});

								if (!game.general.disableGamechat) {
									seatedPlayers.forEach(player => {
										player.gameChats.push(chat);
									});

									game.gameState.audioCue = 'fascistsWinHitlerElected';
									game.private.unSeatedGameChats.push(chat);
								}
								sendInProgressGameUpdate(game);
							},
							process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 1000 : 3000
						);

						setTimeout(
							() => {
								game.gameState.audioCue = '';
								game.publicPlayersState.forEach(player => {
									player.cardStatus.isFlipped = true;
								});
								completeGame(game, 'fascist');
							},
							process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 2000 : 4000
						);
					} else {
						passedElection(socket);
					}
				} else {
					if (!game.general.disableGamechat) {
						chat.chat = [
							{
								text: `The election fails and the election tracker moves forward. (${game.trackState.electionTrackerCount + 1}/3)`
							}
						];

						seatedPlayers.forEach(player => {
							player.gameChats.push(chat);
						});

						game.private.unSeatedGameChats.push(chat);
						game.gameState.pendingChancellorIndex = null;
					}

					failedElection();
				}

				sendInProgressGameUpdate(game);
			},
			process.env.NODE_ENV === 'development' ? 2100 : isConsensus ? 1500 : 6000
		);
	};

	if (game.private.lock.selectChancellor) {
		game.private.lock.selectChancellor = false;
	}

	if (seatedPlayers.length !== seatedPlayers.filter(play => play && play.voteStatus && play.voteStatus.hasVoted).length && player && player.voteStatus) {
		player.voteStatus.hasVoted = !player.voteStatus.hasVoted ? true : player.voteStatus.didVoteYes ? !data.vote : data.vote;
		player.voteStatus.didVoteYes = player.voteStatus.hasVoted ? data.vote : false;
		game.publicPlayersState[playerIndex].isLoader = !player.voteStatus.hasVoted;

		if (force) {
			player.voteStatus.hasVoted = true;
			player.voteStatus.didVoteYes = data.vote;
			game.publicPlayersState[playerIndex].isLoader = false;
		}

		if (data.vote) {
			player.cardFlingerState = [
				{
					position: 'middle-left',
					notificationStatus: !player.voteStatus.hasVoted ? 'notification' : 'selected',
					action: 'active',
					cardStatus: {
						isFlipped: true,
						cardFront: 'ballot',
						cardBack: 'ja'
					}
				},
				{
					position: 'middle-right',
					notificationStatus: 'notification',
					action: 'active',
					cardStatus: {
						isFlipped: true,
						cardFront: 'ballot',
						cardBack: 'nein'
					}
				}
			];
		} else {
			player.cardFlingerState = [
				{
					position: 'middle-left',
					notificationStatus: 'notification',
					action: 'active',
					cardStatus: {
						isFlipped: true,
						cardFront: 'ballot',
						cardBack: 'ja'
					}
				},
				{
					position: 'middle-right',
					notificationStatus: !player.voteStatus.hasVoted ? 'notification' : 'selected',
					action: 'active',
					cardStatus: {
						isFlipped: true,
						cardFront: 'ballot',
						cardBack: 'nein'
					}
				}
			];
		}

		sendInProgressGameUpdate(game, true);

		if (seatedPlayers.filter(play => play.voteStatus.hasVoted && !play.isDead).length === game.general.livingPlayerCount) {
			game.general.status = 'Tallying results of ballots..';
			seatedPlayers.forEach(player => {
				if (player.cardFlingerState.length) {
					player.cardFlingerState[0].action = player.cardFlingerState[1].action = '';
					player.cardFlingerState[0].action = player.cardFlingerState[1].action = '';
					player.cardFlingerState[0].cardStatus.isFlipped = player.cardFlingerState[1].cardStatus.isFlipped = false;
				}
			});
			sendInProgressGameUpdate(game, true);
			setTimeout(
				() => {
					seatedPlayers.forEach(player => {
						player.cardFlingerState = [];
					});
					sendInProgressGameUpdate(game, true);
				},
				experiencedMode ? 200 : 2000
			);
			setTimeout(
				() => {
					if (game.general.timedMode && game.private.timerId) {
						clearTimeout(game.private.timerId);
						game.private.timerId = null;
						game.gameState.timedModeEnabled = false;
					}
					flipBallotCards(socket);
				},
				process.env.NODE_ENV === 'development' ? 100 : experiencedMode ? 2500 : 3000
			);
		}
	}
};

module.exports.startElection = startElection;
