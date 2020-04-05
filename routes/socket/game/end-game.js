const { sendInProgressGameUpdate, rateEloGame } = require('../util.js');
const { userList, games } = require('../models.js');
const { sendUserList, sendGameList } = require('../user-requests.js');
const Account = require('../../../models/account.js');
const Game = require('../../../models/game');
const buildEnhancedGameSummary = require('../../../models/game-summary/buildEnhancedGameSummary');
const { updateProfiles } = require('../../../models/profile/utils');
const debug = require('debug')('game:summary');
const animals = require('../../../utils/animals');
const adjectives = require('../../../utils/adjectives');
const _ = require('lodash');
const { makeReport } = require('../report.js');
const { CURRENTSEASONNUMBER } = require('../../../src/frontend-scripts/node-constants.js');

/**
 * @param {object} game - game to act on.
 */
const saveGame = game => {
	const summary = game.private.summary.publish();
	const casualBool = game.general.casualGame ? true : false; // Because Mongo is explicitly typed and integers are not truthy according to it
	/**
	 * @param {object} - object describing game model.
	 */
	const gameToSave = new Game({
		uid: game.general.uid,
		date: new Date(),
		chats: game.chats,
		isVerifiedOnly: game.general.isVerifiedOnly,
		season: CURRENTSEASONNUMBER,
		winningPlayers: game.private.seatedPlayers
			.filter(player => player.wonGame)
			.map(player => ({
				userName: player.userName,
				team: player.role.team,
				role: player.role.cardName
			})),
		losingPlayers: game.private.seatedPlayers
			.filter(player => !player.wonGame)
			.map(player => ({
				userName: player.userName,
				team: player.role.team,
				role: player.role.cardName
			})),
		winningTeam: game.gameState.isCompleted,
		playerCount: game.general.playerCount,
		rebalance6p: game.general.rebalance6p,
		rebalance7p: game.general.rebalance7p,
		rebalance9p2f: game.general.rebalance9p2f,
		casualGame: casualBool,
		customGame: game.customGameSettings.enabled,
		isRainbow: game.general.rainbowgame,
	});

	let enhanced;

	try {
		if (summary && summary.toObject() && game.general.uid !== 'devgame' && !game.general.private) {
			enhanced = buildEnhancedGameSummary(summary.toObject());
			updateProfiles(enhanced, { cache: true });
			if (!game.summarySaved) {
				summary.save();
				game.summarySaved = true;
			}
		} else {
			// console.log(summary, 'problem with summary');
		}
	} catch (error) {
		console.log(error, 'error in enhanced/end-game');
	}

	debug('Saving game: %O', summary);
	gameToSave.save();
};

/**
 * @param {object} game - game to act on.
 * @param {string} winningTeamName - name of the team that won this game.
 */
module.exports.completeGame = (game, winningTeamName) => {
	if (game && game.unsentReports) {
		game.unsentReports.forEach(report => {
			makeReport({ ...report }, game, report.type === 'modchat' ? 'modchatdelayed' : 'reportdelayed');
		});
		game.unsentReports = [];
	}

	for (let affectedPlayerNumber = 0; affectedPlayerNumber < game.publicPlayersState.length; affectedPlayerNumber++) {
		const affectedSocketId = Object.keys(io.sockets.sockets).find(
			socketId =>
				io.sockets.sockets[socketId].handshake.session.passport &&
				io.sockets.sockets[socketId].handshake.session.passport.user === game.publicPlayersState[affectedPlayerNumber].userName
		);
		if (!io.sockets.sockets[affectedSocketId]) {
			continue;
		}
		io.sockets.sockets[affectedSocketId].emit('removeClaim');
	}

	if (game && game.general && game.general.timedMode && game.private.timerId) {
		clearTimeout(game.private.timerId);
		game.private.timerId = null;
		game.gameState.timedModeEnabled = false;
	}

	if (game && game.general.isRecorded) {
		console.log('A game attempted to be re-recorded!', game.general.uid);
		return;
	}

	const winningPrivatePlayers = game.private.seatedPlayers.filter(player => player.role.team === winningTeamName);
	const winningPlayerNames = winningPrivatePlayers.map(player => player.userName);
	const { seatedPlayers } = game.private;
	const { publicPlayersState } = game;
	const chat = {
		gameChat: true,
		timestamp: new Date(),
		chat: [
			{
				text: winningTeamName === 'fascist' ? 'Fascists' : 'Liberals',
				type: winningTeamName === 'fascist' ? 'fascist' : 'liberal'
			},
			{ text: ' win the game.' }
		]
	};
	const remainingPoliciesChat = {
		gameChat: true,
		timestamp: new Date(),
		chat: [
			{
				text: 'The remaining policies are '
			}
		].concat(
			game.private.policies
				.map(policyName => ({
					text: policyName === 'liberal' ? 'B' : 'R',
					type: policyName === 'liberal' ? 'liberal' : 'fascist'
				}))
				.concat({
					text: '.'
				})
		)
	};

	winningPrivatePlayers.forEach((player, index) => {
		publicPlayersState.find(play => play.userName === player.userName).notificationStatus = 'success';
		publicPlayersState.find(play => play.userName === player.userName).isConfetti = true;
		player.wonGame = true;
	});

	setTimeout(() => {
		winningPrivatePlayers.forEach((player, index) => {
			publicPlayersState.find(play => play.userName === player.userName).isConfetti = false;
		});
		sendInProgressGameUpdate(game, true);
	}, 15000);

	game.general.status = winningTeamName === 'fascist' ? 'Fascists win the game.' : 'Liberals win the game.';
	game.gameState.isCompleted = winningTeamName;
	;

	publicPlayersState.forEach((publicPlayer, index) => {
		publicPlayer.nameStatus = seatedPlayers[index].role.cardName;
	});

	seatedPlayers.forEach(player => {
		player.gameChats.push(chat, remainingPoliciesChat);
	});

	game.private.unSeatedGameChats.push(chat, remainingPoliciesChat);

	game.summary = game.private.summary;
	debug('Final game summary: %O', game.summary.publish().toObject());

	sendInProgressGameUpdate(game);

	saveGame(game);

	game.general.isRecorded = true;

	if (!game.general.private && !game.general.casualGame && !game.general.unlisted) {
		Account.find({
			username: { $in: seatedPlayers.map(player => player.userName) }
		})
			.then(results => {
				const isRainbow = game.general.rainbowgame;
				const eloAdjustments = rateEloGame(game, results, winningPlayerNames);

				results.forEach(player => {
					const listUser = userList.find(user => user.userName === player.username);
					if (listUser) {
						listUser.eloOverall = player.eloOverall;
						listUser.eloSeason = player.eloSeason;
					}

					const seatedPlayer = seatedPlayers.find(p => p.userName === player.username);
					seatedPlayers.forEach(eachPlayer => {
						const playerChange = eloAdjustments[eachPlayer.userName];
						const activeChange = player.gameSettings.disableSeasonal ? playerChange.changeSeason : playerChange.change;
						if (!player.gameSettings.disableElo) {
							seatedPlayer.gameChats.push({
								gameChat: true,
								timestamp: new Date(),
								chat: [
									{
										text: eachPlayer.userName,
										type: eachPlayer.role.team
									},
									{
										text: ` ${activeChange > 0 ? 'increased' : 'decreased'} by `
									},
									{
										text: Math.abs(activeChange).toFixed(1),
										type: 'player'
									},
									{
										text: ` points.`
									}
								]
							});
						}
					});

					let winner = false;

					if (winningPlayerNames.includes(player.username)) {
						if (isRainbow) {
							player.rainbowWins = player.rainbowWins ? player.rainbowWins + 1 : 1;
							player[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] = player[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
								? player[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] + 1
								: 1;
							player[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] = player[`rainbowLossesSeason${CURRENTSEASONNUMBER}`]
								? player[`rainbowLossesSeason${CURRENTSEASONNUMBER}`]
								: 0;
						}

						player[`winsSeason${CURRENTSEASONNUMBER}`] = player[`winsSeason${CURRENTSEASONNUMBER}`] ? player[`winsSeason${CURRENTSEASONNUMBER}`] + 1 : 1;
						player.wins = player.wins ? player.wins + 1 : 1;
						player[`lossesSeason${CURRENTSEASONNUMBER}`] = player[`lossesSeason${CURRENTSEASONNUMBER}`] ? player[`lossesSeason${CURRENTSEASONNUMBER}`] : 0;
						winner = true;

					} else {
						if (isRainbow) {
							player.rainbowLosses = player.rainbowLosses ? player.rainbowLosses + 1 : 1;
							player[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] = player[`rainbowLossesSeason${CURRENTSEASONNUMBER}`]
								? player[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] + 1
								: 1;
							player[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] = player[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
								? player[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
								: 0;
						}

						player.losses++;
						player[`lossesSeason${CURRENTSEASONNUMBER}`] = player[`lossesSeason${CURRENTSEASONNUMBER}`] ? player[`lossesSeason${CURRENTSEASONNUMBER}`] + 1 : 1;
						player[`winsSeason${CURRENTSEASONNUMBER}`] = player[`winsSeason${CURRENTSEASONNUMBER}`] ? player[`winsSeason${CURRENTSEASONNUMBER}`] : 0;
					}

					player.games.push(game.general.uid);
					player.lastCompletedGame = new Date();
					player.save(() => {
						const userEntry = userList.find(user => user.userName === player.username);

						if (userEntry) {
							if (winner) {
								if (isRainbow) {
									userEntry.rainbowWins = userEntry.rainbowWins ? userEntry.rainbowWins + 1 : 1;
									userEntry.rainbowLosses = userEntry.rainbowLosses ? userEntry.rainbowLosses : 0;
									userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] = userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
										? userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] + 1
										: 1;
									userEntry[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] = userEntry[`rainbowLossesSeason${CURRENTSEASONNUMBER}`]
										? userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
										: 0;
								}
								userEntry.wins = userEntry.wins ? userEntry.wins + 1 : 1;
								userEntry[`winsSeason${CURRENTSEASONNUMBER}`] = userEntry[`winsSeason${CURRENTSEASONNUMBER}`]
									? userEntry[`winsSeason${CURRENTSEASONNUMBER}`] + 1
									: 1;
								userEntry[`lossesSeason${CURRENTSEASONNUMBER}`] = userEntry[`lossesSeason${CURRENTSEASONNUMBER}`]
									? userEntry[`lossesSeason${CURRENTSEASONNUMBER}`]
									: 0;

							} else {
								if (isRainbow) {
									userEntry.rainbowLosses = userEntry.rainbowLosses ? userEntry.rainbowLosses + 1 : 1;
									userEntry[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] = userEntry[`rainbowLossesSeason${CURRENTSEASONNUMBER}`]
										? userEntry[`rainbowLossesSeason${CURRENTSEASONNUMBER}`] + 1
										: 1;
									userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`] = userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
										? userEntry[`rainbowWinsSeason${CURRENTSEASONNUMBER}`]
										: 0;
								}
								userEntry.losses = userEntry.losses ? userEntry.losses + 1 : 1;
								userEntry[`lossesSeason${CURRENTSEASONNUMBER}`] = userEntry[`lossesSeason${CURRENTSEASONNUMBER}`]
									? userEntry[`lossesSeason${CURRENTSEASONNUMBER}`] + 1
									: 1;
								userEntry[`winsSeason${CURRENTSEASONNUMBER}`] = userEntry[`winsSeason${CURRENTSEASONNUMBER}`]
									? userEntry[`winsSeason${CURRENTSEASONNUMBER}`]
									: 0;
							}

							sendUserList();
						}
					});
				});
				sendInProgressGameUpdate(game);
			})
			.catch(err => {
				console.log(err, 'error in updating accounts at end of game');
			});
	}
};
