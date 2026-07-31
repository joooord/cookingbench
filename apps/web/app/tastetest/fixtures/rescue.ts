import type { FixtureItem } from './types';

/**
 * Rescue track — five authored rounds, three voices each.
 *
 * Rescue rounds carry the optional matched KitchenPlan/timeline view (M5.2).
 * Both sides declare their steps on the SAME clock convention (T−40 … T−0,
 * counting down to service), because a timeline that reads T+ on one side and
 * T− on the other is a comparison the reader has to do arithmetic for, and the
 * arithmetic is not what is being measured.
 *
 * Author sets ring in the same way the flavour track's do, for the same reason:
 * disjoint sets give a permanently disconnected comparison graph.
 */
export const rescueItems: FixtureItem[] = [
  {
    id: 'fx-rescue-001',
    track: 'rescue',
    task: 'A beef shin braise for eight has been in a low oven for three hours and the meat is still tough. Service is in forty minutes and the guests are already here. Propose the recovery.',
    judgingQuestion: 'Whose plan would you rather be following, with forty minutes on the clock?',
    reasons: ['More likely to work', 'Better under time pressure', 'Clearer about what to do'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'All proposals keep the braise above 75°C throughout; none propose holding cooked meat in the danger zone.' },
    proposals: [
      {
        authorId: 'fixture/brine',
        body: 'Tough at three hours means undercooked, not overcooked, and the fix is heat rather than time. Move the pot to the hob, bring the liquid to a genuine simmer with the lid on, and hold it there. Collagen converts fastest around a bare simmer and an oven at 140°C may never have got the middle of a full pot there at all. Meanwhile buy yourself room: put out bread, the salad, anything, and tell people dinner is twenty minutes later than you said. At twenty minutes, test a piece from the centre of the pot rather than the edge. If it is close, it will finish while you plate. If it is not, shred the meat off the bone — shredded shin at forty minutes eats far better than sliced shin at ninety.',
        timeline: [
          { at: 'T−40', action: 'Pot from oven to hob, lid on, bring to a bare simmer.' },
          { at: 'T−35', action: 'Bread and salad out; announce a twenty-minute delay.' },
          { at: 'T−20', action: 'Test a piece from the centre of the pot, not the edge.' },
          { at: 'T−10', action: 'If still firm, lift the meat and shred it; return to the liquor.' },
          { at: 'T−0', action: 'Serve shredded over whatever was going to go under it.' },
        ],
      },
      {
        authorId: 'fixture/dill',
        body: 'Split the problem. Lift the meat out, cut it into pieces no thicker than a thumb, and return it to the pot on the hob at a simmer — you have just reduced the distance heat has to travel by two thirds, which is worth more than any extra half hour. While that goes, strain a third of the liquor into a wide pan and reduce it hard; braising liquor from an undercooked pot is thin and under-flavoured, and a concentrated spoonful poured back at the end will cover for meat that is merely tender rather than falling. Check at fifteen minutes and again at twenty-five. Do not add more liquid at any point: you are short of time, not short of sauce.',
        timeline: [
          { at: 'T−40', action: 'Lift meat, cut to thumb thickness, return to a simmering pot.' },
          { at: 'T−38', action: 'Strain a third of the liquor into a wide pan, reduce hard.' },
          { at: 'T−25', action: 'Test a piece; taste the reduction and season it.' },
          { at: 'T−10', action: 'Pour the reduction back; do not add water at any stage.' },
          { at: 'T−0', action: 'Serve, spooning the concentrated liquor over each plate.' },
        ],
      },
      {
        authorId: 'fixture/fennel',
        body: 'Pressure, if you have a pressure cooker, and honesty if you do not. Transfer meat and enough liquor to cover into the pressure cooker, bring to high pressure, and give it twenty minutes with a natural release — shin at pressure is genuinely different arithmetic and twenty minutes will do what another hour in the oven would. Reduce the remaining liquor in a wide pan meanwhile so nothing is lost. If there is no pressure cooker, do not pretend the braise will arrive: serve the reduced liquor as a soup with the bread, keep the pot going, and put the meat out an hour later as a second course. A late dish that is right beats an on-time dish that people chew through politely.',
        timeline: [
          { at: 'T−40', action: 'Meat and covering liquor into the pressure cooker; bring to high pressure.' },
          { at: 'T−36', action: 'Remaining liquor into a wide pan, reduce and season.' },
          { at: 'T−16', action: 'Heat off; natural release, no quick venting.' },
          { at: 'T−5', action: 'Combine, taste, adjust salt against the reduction.' },
          { at: 'T−0', action: 'If no pressure cooker: serve broth and bread now, meat in an hour.' },
        ],
      },
    ],
  },
  {
    id: 'fx-rescue-002',
    track: 'rescue',
    task: 'A litre of mayonnaise has split into an oily curdled mess. Twelve plates need it in fifteen minutes and there are four eggs left in the fridge.',
    judgingQuestion: 'Whose plan would you rather be following, with fifteen minutes on the clock?',
    reasons: ['More likely to work', 'Better under time pressure', 'Clearer about what to do'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'Raw egg throughout, as in the original preparation; each proposal names pasteurised egg as the substitution for vulnerable guests rather than implying the rescue changes the risk.' },
    proposals: [
      {
        authorId: 'fixture/fennel',
        body: 'Rebuild it, do not beat it harder. Put a teaspoon of water and a teaspoon of mustard in a clean bowl and whisk the split mixture into that, a spoonful at a time, waiting for each addition to take before the next. Water first is the part people skip; an emulsion that has broken is short of continuous phase, not short of effort. The whole litre will come back in about six minutes if you are disciplined about the spoonful rule and about four if you use a stick blender in a narrow jug. This uses raw egg exactly as the original did; use pasteurised egg instead if anyone at the table is pregnant, elderly or immunocompromised. Keep it cold until it goes out.',
        timeline: [
          { at: 'T−15', action: 'Clean bowl: 1 tsp water, 1 tsp mustard, whisk to combine.' },
          { at: 'T−14', action: 'Add split mixture one spoonful at a time; wait for each to take.' },
          { at: 'T−8', action: 'Halfway check — if it is grainy, stop adding and whisk it smooth.' },
          { at: 'T−4', action: 'Finish the litre; season and slacken with lemon if it is too stiff.' },
          { at: 'T−0', action: 'Back to the fridge until the plates go out.' },
        ],
      },
      {
        authorId: 'fixture/hearth',
        body: 'Fresh yolk, and spend one of the four. Whisk a single yolk with a pinch of salt in a clean bowl until it thickens slightly, then trickle the split mayonnaise into it exactly as if it were oil — thread-thin at first, faster once it has clearly taken. It will come back, and it will come back richer than it was, which is a fair trade with twelve minutes left. Do not tip the split mixture in fast at the start because you can see it working; that is precisely when it breaks a second time and you will be down to three eggs. Raw egg, as before: pasteurised yolk if any guest is vulnerable. Taste at the end, because a rescued mayonnaise is nearly always under-seasoned.',
        timeline: [
          { at: 'T−15', action: 'One fresh yolk and a pinch of salt, whisked until it thickens.' },
          { at: 'T−13', action: 'Trickle in the split mixture thread-thin until it visibly takes.' },
          { at: 'T−9', action: 'Increase the stream, still steadily; stop if it looks loose.' },
          { at: 'T−4', action: 'Season and check acidity; it will need more salt than you expect.' },
          { at: 'T−0', action: 'Cold until service; keep the remaining three eggs in reserve.' },
        ],
      },
      {
        authorId: 'fixture/kelp',
        body: 'Change the dish instead of the sauce. A split mayonnaise is oil, yolk, acid and mustard, all of which are already correct — whisk in a spoonful of hot water and it becomes a perfectly good warm dressing, or fold it into mashed potato and it disappears entirely. With twelve covers and fifteen minutes, the risk of a second break is real, and a confident substitution beats a nervous repair. Say what changed when it goes out; people mind a surprise far less than they mind a silence, and a warm dressing announced as a warm dressing is a dish rather than a failure. If the menu genuinely cannot move — if the sauce is the point of the plate rather than a component of it — use the fresh-yolk rebuild instead and accept the risk of a second break. Raw egg either way, so pasteurised egg if there is a vulnerable guest.',
        timeline: [
          { at: 'T−15', action: 'Decide: does the plate survive a warm dressing instead of a mayonnaise?' },
          { at: 'T−13', action: 'If yes — whisk a spoonful of hot water through; taste and season.' },
          { at: 'T−10', action: 'If no — one fresh yolk, rebuild thread-thin, as the other plan.' },
          { at: 'T−5', action: 'Tell the room what changed before the plates land.' },
          { at: 'T−0', action: 'Serve; keep the spare eggs for the next service.' },
        ],
      },
    ],
  },
  {
    id: 'fx-rescue-003',
    track: 'rescue',
    task: 'Rice for eight is twenty minutes from service, the pan has boiled dry, the base is catching and the grains still have a hard core.',
    judgingQuestion: 'Whose plan would you rather be following, with twenty minutes on the clock?',
    reasons: ['More likely to work', 'Better under time pressure', 'Clearer about what to do'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'Cooked rice is served straight away in every proposal; none advises holding it warm for hours or cooling it slowly, which is the Bacillus cereus risk.' },
    proposals: [
      {
        authorId: 'fixture/kelp',
        body: 'Off the heat first, before anything else, and do not stir — stirring drags the scorched layer up through the whole pan and you lose the lot. Tip the loose rice into a fresh pan, leaving the catching base behind entirely, and smell what you have transferred. If it smells clean, add a hundred millilitres of boiling water, lid on, lowest heat for eight minutes, then off the heat for five with the lid still on. That last five minutes is where a hard core actually finishes; it is steam, not boiling, that does it. Serve immediately. If the rice you transferred already smells of scorch, you cannot fix it, and twenty minutes is enough to cook a fresh pan if you start now.',
        timeline: [
          { at: 'T−20', action: 'Heat off. Do not stir.' },
          { at: 'T−19', action: 'Tip loose rice into a fresh pan; leave the caught base behind.' },
          { at: 'T−18', action: 'Smell it. Scorched? Start a fresh pan now, you have time.' },
          { at: 'T−17', action: '100 ml boiling water, lid on, lowest heat, eight minutes.' },
          { at: 'T−9', action: 'Heat off, lid on, five minutes undisturbed.' },
          { at: 'T−0', action: 'Fork through and serve straight away.' },
        ],
      },
      {
        authorId: 'fixture/ash',
        body: 'Steam it, in a colander over simmering water, which removes every remaining way it can catch. Lift the good rice out with a spoon rather than pouring, so the base stays where it is, and spread it in a colander lined with a cloth. Fifteen minutes over a gentle simmer with a lid or a plate on top and the hard cores will be gone. It is slower than adding water to a pan and far more forgiving, which is what you want when the first attempt has already gone wrong once. Do not rinse it — the surface starch is holding the grains together and it is the only thing making this look deliberate. Serve as soon as it is done.',
        timeline: [
          { at: 'T−20', action: 'Heat off; spoon the good rice out, leave the caught base.' },
          { at: 'T−18', action: 'Into a cloth-lined colander over a pan of simmering water.' },
          { at: 'T−17', action: 'Lid or plate on top; gentle simmer, do not let it boil dry too.' },
          { at: 'T−4', action: 'Test three grains from different places in the colander.' },
          { at: 'T−0', action: 'Serve immediately; do not hold it warm for long.' },
        ],
      },
      {
        authorId: 'fixture/cinder',
        body: 'Commit to the scorch and make it the dish. Leave the pan exactly as it is, off the heat for two minutes, then sprinkle fifty millilitres of boiling water down the side, clamp the lid on, and give it eight minutes on the lowest flame you have. What forms at the base is a crust, and a deliberate crust served in pieces on top reads as intent rather than accident. This only works if the base is brown; if it is black, or if the steam smells bitter when you lift the lid, abandon it and cook a fresh pan instead, because burnt sugar carries through an entire dish and cannot be seasoned out. Twenty minutes is enough for a fresh pan if you decide early. Taste the rice at the eight-minute mark before deciding which of those two things you are doing, not after.',
        timeline: [
          { at: 'T−20', action: 'Heat off, lid off, two minutes to stop the base cooking further.' },
          { at: 'T−18', action: 'Look and smell: brown crust or black? Bitter steam means abandon.' },
          { at: 'T−17', action: '50 ml boiling water down the side, lid clamped on, lowest flame.' },
          { at: 'T−9', action: 'Taste. Hard core gone? If not, five more minutes off the heat.' },
          { at: 'T−0', action: 'Serve, breaking the crust over the top in pieces.' },
        ],
      },
    ],
  },
  {
    id: 'fx-rescue-004',
    track: 'rescue',
    task: 'A caramel for a tart has seized into a solid amber lump around the spoon. Dessert is in thirty minutes and there is enough sugar for one more attempt.',
    judgingQuestion: 'Whose plan would you rather be following, with thirty minutes on the clock?',
    reasons: ['More likely to work', 'Better under time pressure', 'Clearer about what to do'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'Molten sugar burns are the real hazard; every proposal warns before adding liquid to hot sugar rather than after.' },
    proposals: [
      {
        authorId: 'fixture/cinder',
        body: 'Seized caramel is crystallised, not ruined, and heat undoes it. Put the pan back on a low flame with two tablespoons of water and leave it alone — no stirring, no scraping, no helpful poking — and the lump will dissolve in five or six minutes. Swirl the pan if you must move it. Stirring is what crystallised it in the first place and stirring is what will do it again. Once it is liquid, bring it back up to the colour you wanted. Stand back when you add anything wet to hot sugar: it will spit violently and molten sugar sticks to skin. If it seizes a second time you still have twenty minutes and enough sugar, which is the reason to try this before starting again rather than after.',
        timeline: [
          { at: 'T−30', action: 'Pan back on a low flame with two tablespoons of water.' },
          { at: 'T−29', action: 'Hands off. Swirl if it needs moving; do not stir or scrape.' },
          { at: 'T−24', action: 'Once clear, raise the heat and take it to colour.' },
          { at: 'T−18', action: 'Stand back to add cream or butter; it will spit.' },
          { at: 'T−0', action: 'Second failure still leaves time and sugar for one fresh attempt.' },
        ],
      },
      {
        authorId: 'fixture/ember',
        body: 'Start again, wet, and stop having this problem. Thirty minutes is comfortable for a fresh caramel and a wet method is much harder to seize: sugar, enough water to make wet sand, and no stirring at all once it is on the heat. Brush the inside of the pan down with a wet pastry brush twice in the first two minutes to take out the stray crystals that start the chain reaction. Meanwhile put the seized lump in a bowl of hot water to dissolve and keep it as a syrup for something else, so nothing is wasted and you are not stood over it. Anything wet added to hot sugar erupts, so have the cream measured, warmed and within reach before you need it.',
        timeline: [
          { at: 'T−30', action: 'Seized lump into a bowl of hot water to dissolve; set aside.' },
          { at: 'T−28', action: 'Fresh pan: sugar plus water to the texture of wet sand.' },
          { at: 'T−26', action: 'Brush the pan walls down twice; then do not touch it again.' },
          { at: 'T−16', action: 'Take to colour; warmed cream measured and standing by.' },
          { at: 'T−0', action: 'Off the heat, add the cream at arm’s length, whisk smooth.' },
        ],
      },
      {
        authorId: 'fixture/gale',
        body: 'Change what the caramel is for. Melt the seized lump with a splash of water back to a syrup — six minutes, no stirring — and instead of a set caramel layer, serve it as a hot sauce poured over the tart at the table. A poured sauce does not need to behave at a particular temperature, does not need to set, and cannot seize a second time on you at the point of plating. It also buys back the twenty minutes you would have spent watching a second attempt. Say it is a sauce; nobody is comparing it to the tart they did not get. Hot sugar and water spit, so keep your face away from the pan when the water goes in.',
        timeline: [
          { at: 'T−30', action: 'Splash of water into the pan, low heat, no stirring.' },
          { at: 'T−24', action: 'Once liquid, adjust with a little more water to pouring thickness.' },
          { at: 'T−20', action: 'Taste; a pinch of salt if it is one-dimensional.' },
          { at: 'T−5', action: 'Keep warm; do not reduce it further or it will set on the plate.' },
          { at: 'T−0', action: 'Pour over the tart at the table.' },
        ],
      },
    ],
  },
  {
    id: 'fx-rescue-005',
    track: 'rescue',
    task: 'A dough left to prove overnight has collapsed, smells strongly of alcohol and will not hold a shape. It is ten in the morning and bread is wanted at one.',
    judgingQuestion: 'Whose plan would you rather be following, with three hours on the clock?',
    reasons: ['More likely to work', 'Better under time pressure', 'Clearer about what to do'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'Over-proved dough is a quality problem, not a safety one; no proposal implies otherwise or advises baking under-cooked bread.' },
    proposals: [
      {
        authorId: 'fixture/gale',
        body: 'Knock it back hard, add structure, and reset the clock. Turn it out, press the gas out properly rather than politely, and knead in a hundred grams of fresh flour with a good pinch of salt — the salt is the part that matters, because an over-proved dough has run out of it in the sense that the yeast has eaten through everything holding the crumb together. Shape tightly, seam side down, and give it a single ninety-minute prove somewhere cool rather than warm. Cool is the correction: you are trying to slow it, not encourage it. It will smell less of alcohol as it goes. Bake hot with steam for the first ten minutes. It will not be the loaf you meant, but it will be bread at one.',
        timeline: [
          { at: 'T−180', action: 'Turn out and knock back thoroughly; do not be gentle.' },
          { at: 'T−175', action: 'Knead in 100 g flour and a pinch of salt until it tightens.' },
          { at: 'T−170', action: 'Shape tightly, seam down; prove somewhere cool, not warm.' },
          { at: 'T−80', action: 'Check: it should be domed, not spreading. Oven on, hot.' },
          { at: 'T−45', action: 'Bake with steam for the first ten minutes.' },
          { at: 'T−0', action: 'Out, and cooled at least twenty minutes before it is cut.' },
        ],
      },
      {
        authorId: 'fixture/juniper',
        body: 'Stop treating it as a loaf. An over-proved dough has lost the gluten structure that lets it hold height, and no amount of reshaping will give that back in three hours — but it is still perfectly good flavour, and flat breads do not need height. Divide it, roll each piece thin, and cook them on a dry hot pan in two minutes a side. The alcohol smell cooks off entirely. You will have bread on the table an hour early with no further risk, and it will taste better than a dense, sour, half-risen loaf pretending nothing happened. If somebody really wants a loaf, keep a third of the dough back, knock it down and try the long route with it while the flatbreads cover the meal.',
        timeline: [
          { at: 'T−180', action: 'Decide: flatbreads for certain, or a loaf on a gamble.' },
          { at: 'T−175', action: 'Divide; keep a third back if a loaf is still wanted.' },
          { at: 'T−60', action: 'Roll thin; rest ten minutes so they stop springing back.' },
          { at: 'T−40', action: 'Dry hot pan, two minutes a side, stack under a cloth.' },
          { at: 'T−0', action: 'Serve; the reserved third bakes as a loaf whenever it is ready.' },
        ],
      },
      {
        authorId: 'fixture/brine',
        body: 'Use it as a preferment and build a new dough around it. Take four hundred grams of the collapsed dough, mix it with five hundred grams of fresh flour, three hundred and twenty of water and twelve of salt, and work it until it comes together — you now have a dough with a mature, well-flavoured starter in it and a fresh gluten network that has not been eaten through. Two hours bulk, forty minutes shaped, bake at one. The alcohol note reads as depth once it is diluted at this ratio. It is more work than knocking back and more flour than you may want to spend, but it is the only route that gives a proper open crumb, and the timing is genuinely tight rather than optimistic.',
        timeline: [
          { at: 'T−180', action: '400 g old dough, 500 g flour, 320 g water, 12 g salt; mix.' },
          { at: 'T−170', action: 'Work until smooth; it will look slack for the first few minutes.' },
          { at: 'T−165', action: 'Bulk two hours, folding once at the halfway point.' },
          { at: 'T−45', action: 'Shape and prove forty minutes; oven hot with a tray in it.' },
          { at: 'T−0', action: 'Bake with steam; accept it may run ten minutes late.' },
        ],
      },
    ],
  },
];
