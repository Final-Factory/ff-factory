// Owner replies in a bug thread and whether each acknowledges the report as a bug (w1783). Ben, 2026-10-22: "it doesn't
// have to literally say, will fix. Like, any indication that I'm acknowledging it as a bug is sufficient." The flow test
// (bugThreads.test.ts) files a request for each `ack` and none for each `not`; scripts/ownerAckEval.ts asks the real judge
// the same cases and must agree with every one. Each has the report it answers, since a reply means something only there.

export interface AckCase {
  report: string;
  title: string;
  reply: string;
  ack: boolean;
}

export const ACK_CASES: readonly AckCase[] = [
  // What Ben wrote in the two threads the w1779 audit found without a request.
  { title: 'Upgrade Tools - Mining T2 missing', report: 'The Mining T2 upgrade is not in the upgrade tools list after I researched it.', reply: 'Will fix', ack: true },
  { title: 'Missing Crafting Material Quantities in Japanese', report: 'In Japanese the crafting panel shows the materials but not how many of each.', reply: "We'll fix this, thanks", ack: true },
  // Acknowledgements in other words.
  { title: 'Mass driver stops after load', report: 'After loading my save the mass drivers no longer fire until I rebuild them.', reply: 'yeah thats a bug', ack: true },
  { title: 'Belt splitter eats items', report: 'The splitter deletes every third item when both outputs are full.', reply: 'Good catch!', ack: true },
  { title: 'Fog deconstruct', report: 'I can deconstruct buildings under the fog of war that I have never seen.', reply: 'oops', ack: true },
  { title: 'Crash when opening the circuit tab', report: 'The game crashes every time I open the circuit tab on a station. Log attached.', reply: 'Thanks, looking into it', ack: true },
  { title: 'Station Grid info wrong', report: 'The station grid info panel shows power for the wrong station.', reply: 'Confirmed, I can reproduce it here.', ack: true },
  { title: 'Leeches ignore turrets', report: 'Leeches fly straight through turret range and nothing shoots them.', reply: 'on it', ack: true },
  { title: 'Save tab blank', report: 'The save tab is empty even though I have twelve saves.', reply: "that's on us, fix coming in the next patch", ack: true },
  // Not an acknowledgement: a question back, as designed, a feature request, already fixed, chatter.
  { title: 'Game does not start', report: 'I got the issue today that the game does not start correct.', reply: 'Can you send your Player.log and say which version you are on?', ack: false },
  { title: 'Turrets too weak', report: 'Turrets feel too weak against the second wave.', reply: "That's working as designed, the second wave is meant to push you to upgrade.", ack: false },
  { title: 'Please add a sort button', report: 'The inventory should have a sort button.', reply: "That's a feature request, not a bug. Post it in #suggestions.", ack: false },
  { title: 'Belts flicker', report: 'Belts flicker when zoomed out on 1.0.0.2.', reply: 'This was already fixed in 1.0.0.4, please update.', ack: false },
  { title: 'Lag with blueprints', report: 'Placing a big blueprint lags the game for a few seconds.', reply: 'lol nice base though', ack: false },
  { title: 'Enemies on the map', report: 'Enemies show on the map before I have scouted them.', reply: 'Does it still happen after a restart?', ack: false },
  // Held out: wordings the judge's prompt does not show, so a pass is its reading, not a phrase match.
  { title: 'Splitter priority broken', report: 'Priority output on the splitter is ignored since the update.', reply: 'ugh, I broke this in the last patch', ack: true },
  { title: 'Japanese item counts', report: 'Item counts are missing in the Japanese build tooltip.', reply: 'ty, adding it to the list for the next build', ack: true },
  { title: 'Drones stuck at dock', report: 'Drones sit at the dock forever when the target station is full.', reply: 'Reproduced on my end. The full-station check never clears.', ack: true },
  { title: 'Capitals in text boxes', report: 'I cannot type capital letters in the station name box.', reply: 'Lothsahn, can you take this one? Looks like the input field drops shift.', ack: true },
  { title: 'Research not unlocking', report: 'Mining T2 never unlocks for me.', reply: "You need to research Advanced Drills first, it's under mining in the tech tree.", ack: false },
  { title: 'Want a minimap zoom', report: 'The minimap needs a zoom slider.', reply: "We know a few people want this, maybe after 1.0.", ack: false },
  { title: 'Desync on join', report: 'My friend desyncs a minute after joining my game.', reply: 'Is this on the beta branch or the public one?', ack: false },
  { title: 'Power grid shows negative', report: 'The power panel shows -40 MW while everything runs.', reply: 'Hey, welcome to the discord!', ack: false },
];
