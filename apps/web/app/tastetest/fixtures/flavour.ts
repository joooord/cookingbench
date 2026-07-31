import type { FixtureItem } from './types';

/**
 * Flavour track — five authored rounds, three voices each.
 *
 * The author sets deliberately OVERLAP in a ring (ash–brine–cinder–dill–ember–
 * fennel–gale–hearth–juniper–kelp–ash). Disjoint sets would be easier to write
 * and would produce a permanently disconnected comparison graph: five isolated
 * pairs that can never be ranked against one another, which `fitDavidson`
 * refuses outright. The ring means the pairings a flight can legally draw union
 * to a ten-cycle, which is connected.
 */
export const flavourItems: FixtureItem[] = [
  {
    id: 'fx-flavour-001',
    track: 'flavour',
    task: 'A pot of white beans with wilted greens is cooked and correctly seasoned, and it still eats like a hospital lunch. Propose one flavour direction that finishes it.',
    judgingQuestion: 'Which finish would you rather eat, tonight, out of this bowl?',
    reasons: ['It sounded more delicious', 'It suited the dish better', 'It was clearer about how'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'No allergen claim, no raw-protein handling, no preserving instruction.' },
    proposals: [
      {
        authorId: 'fixture/ash',
        body: 'Melt four anchovy fillets into warm olive oil with a bruised rosemary sprig and two sliced garlic cloves, off the direct heat, until the anchovy collapses and stops smelling of fish. Pull the rosemary. Stir half through the beans, mash a ladleful against the side of the pot to thicken the liquor, then finish with lemon zest and a hard squeeze of juice. Spoon the rest over the top so the surface stays glossy rather than stirred in and lost. Salt last, because the anchovy has already brought most of it. The beans should taste savoury and slightly resinous, not fishy; if anyone can name the anchovy, it went in too hot. Serve warm, not scalding, with bread that can be dragged through what collects at the bottom.',
        sensory: {
          identity: 'Savoury, resinous, unmistakably a bean dish rather than a sauce dish.',
          aroma: 'Warm olive oil and rosemary first, garlic underneath, no fish note at all.',
          balance: 'Salt from the anchovy, acid from the lemon, no sugar anywhere.',
          texture: 'Loose and creamy from the mashed ladleful, served warm rather than hot.',
          progression: 'Opens soft and starchy, turns savoury mid-bite, finishes bright and short.',
          failure: 'Anchovy fried too hot goes acrid and fishy; melt it off the heat and start again if it browns.',
          restraint: 'No chilli, no cheese, no herb garnish. One savoury idea, followed through.',
        },
      },
      {
        authorId: 'fixture/brine',
        body: 'Go loud. Fry a slice of stale bread torn into rough crumbs in generous oil with a pinch of chilli flakes until they are properly brown, not blond, and drain them on paper so they stay crisp. Meanwhile chop the rind of half a preserved lemon very fine, discarding the flesh, and stir it through the hot beans with a spoonful of the fried oil. Taste before adding any salt at all; preserved lemon carries a great deal. Scatter the crumbs over each bowl at the table, not in the pot, so they are still audible. The point is contrast: soft beans, sharp citrus, hot fat, loud crunch. It reads as a deliberate dish rather than a pot that needed rescuing, and it costs a slice of bread nobody was going to eat.',
        sensory: {
          identity: 'A contrast dish: the crunch is the idea, the beans are the setting.',
          aroma: 'Toasted bread and warm chilli, with citrus arriving a beat later.',
          balance: 'Salt entirely from the preserved lemon; heat low; no added acid needed.',
          texture: 'Soft against genuinely crisp, both warm, the crumbs added at the table.',
          progression: 'Crunch first, then the beans, finishing with a long saline citrus hum.',
          failure: 'Crumbs added in the pot go soft within a minute; scatter them in the bowl.',
          restraint: 'No cheese and no herbs, which would blur the two textures into one.',
        },
      },
      {
        authorId: 'fixture/cinder',
        body: 'Cook fifty grams of butter until the milk solids are nut-brown and the foam subsides, then drop in eight sage leaves for fifteen seconds so they crisp without blackening. Pour the lot over the beans. Separately, if you have a parmesan rind, drop it into the pot twenty minutes before you finish and fish it out; if you do not, grate cheese over at the table instead and accept that the effect is sharper and less deep. Loosen with a splash of the bean cooking liquor rather than water so nothing tastes diluted. Black pepper, coarse, at the end. This is the comfortable answer rather than the clever one: fat, savoury depth, and a bitter edge from the browned solids that keeps it from being merely rich.',
        sensory: {
          identity: 'Rich and nutty; the browned butter is the dish, the beans carry it.',
          aroma: 'Hazelnut from the butter, sage on top, faint cheese underneath.',
          balance: 'Fat-forward with a bitter edge; no acid, which is the deliberate risk.',
          texture: 'Glossy and thick, hot, with crisp sage shattering against soft beans.',
          progression: 'Opens rich, deepens through the middle, finishes long and slightly bitter.',
          failure: 'Butter taken past nut-brown turns acrid; pull it off the heat early, it carries on cooking.',
          restraint: 'No lemon. The bitterness is doing the work acid usually does.',
        },
      },
    ],
  },
  {
    id: 'fx-flavour-002',
    track: 'flavour',
    task: 'Two trays of carrots are roasted and slightly caramelised for a winter lunch. Propose the dressing or finish they are served under.',
    judgingQuestion: 'Which tray would you rather put in the middle of the table?',
    reasons: ['It sounded more delicious', 'It suited a winter table better', 'It was clearer about how'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'Dairy and nut components named explicitly so an allergen reader can see them.' },
    proposals: [
      {
        authorId: 'fixture/cinder',
        body: 'Toast a heaped teaspoon of cumin seed in a dry pan until it smells of more than dust, then crush it coarsely. Loosen thick yoghurt with a little water and lemon juice until it pours slowly, salt it properly, and spread it across the warm platter first so the carrots land on it rather than under it. Scatter the cumin, then a thin thread of honey, then a great deal of chopped dill and its softer stalks. Serve while the carrots are still warm enough to slacken the yoghurt where they touch it but not so hot that it splits into a grey puddle. The sweetness of a winter carrot is already the loudest thing on the plate, so the honey is a thread, not a drizzle, and the lemon is not optional.',
        sensory: {
          identity: 'A cold-against-warm platter; the yoghurt is a base, not a sauce on top.',
          aroma: 'Toasted cumin first, then dill; the honey is not smelt, only tasted.',
          balance: 'Sweet carrot against sour yoghurt and lemon, salt high, honey minimal.',
          texture: 'Cool and slack under hot and caramelised, going creamy where they meet.',
          progression: 'Cool and sour on the first bite, sweet through the middle, herbal at the end.',
          failure: 'Yoghurt splits if the carrots go on straight from a hot oven; rest them five minutes.',
          restraint: 'No garlic, no nuts, no chilli. Three flavours and one of them is the carrot.',
        },
      },
      {
        authorId: 'fixture/dill',
        body: 'Beat a tablespoon of rose harissa into softened butter with a scrape of orange zest and keep it cold until the carrots come out. Drop it over them straight from the oven and toss so the butter melts into the caramelised edges rather than sitting on top. Finish with roughly chopped pistachios, toasted separately, and a few coriander leaves. Contains dairy and nuts, which is worth saying out loud at a shared table. The heat should be low enough that a second helping is obvious rather than brave; harissa brands vary wildly, so mix, taste on a piece of carrot, and adjust before it goes anywhere near the tray. Orange and carrot is a tired pairing on paper and an excellent one in the mouth, provided the zest stays a suggestion.',
        sensory: {
          identity: 'A spiced butter dish; the harissa is warm and floral rather than fiery.',
          aroma: 'Rose and orange over toasted chilli, with a green pistachio note underneath.',
          balance: 'Sweet and fat-forward, gentle heat, acid only from the zest — the weak point.',
          texture: 'Glossy and slippery with a hard crunch from the nuts, everything hot.',
          progression: 'Sweet and buttery, then a slow build of heat that finishes warm, not sharp.',
          failure: 'Harissa strength varies fourfold between brands; taste before it hits the tray.',
          restraint: 'No yoghurt and no lemon, which would turn a warm dish into a cold one.',
        },
      },
      {
        authorId: 'fixture/ember',
        body: 'Make a sharp, almost aggressive dressing while the carrots roast: two parts cider vinegar to three parts oil, a teaspoon of caraway seed bruised in a mortar, a scrape of grated onion, salt, and a good deal of black pepper. Pour half of it over the carrots the moment they leave the oven, when they are hot enough to drink it in, and keep the rest for the table. Spoon crème fraîche in loose blobs rather than a layer, so some mouthfuls get it and some do not. Caraway is divisive and unmissable, which is the point: a tray of roast carrots is a dull thing to be neutral about. If you have parsley, use the stalks as well; they are more peppery than the leaves and stand up to the vinegar.',
        sensory: {
          identity: 'A sharp, Northern European plate; caraway declares itself immediately.',
          aroma: 'Cider vinegar and caraway, with raw onion just detectable behind them.',
          balance: 'Acid-led and salty, sweetness from the carrot alone, fat held in reserve.',
          texture: 'Hot carrots slick with dressing against cold, thick blobs of crème fraîche.',
          progression: 'Sharp opening, sweet middle where the crème fraîche lands, aniseed finish.',
          failure: 'Dressing added to cold carrots sits on the surface; it has to go on hot.',
          restraint: 'No honey and no herbs beyond parsley stalk. Nothing softens the vinegar.',
        },
      },
    ],
  },
  {
    id: 'fx-flavour-003',
    track: 'flavour',
    task: 'Four whole mackerel are going on a hot grill, skin scored, salted an hour ahead. Propose the one accompaniment that carries the plate.',
    judgingQuestion: 'Which plate would you rather be handed?',
    reasons: ['It sounded more delicious', 'It handled the oily fish better', 'It was clearer about how'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'All accompaniments are cooked or acidic; no cured or raw fish preparation is proposed.' },
    proposals: [
      {
        authorId: 'fixture/ember',
        body: 'Gooseberries, and almost nothing else. Simmer three hundred grams with a splash of water and a pinch of salt until they burst, then beat in a knob of butter and only as much sugar as it takes to stop the sauce being painful — usually far less than a recipe will tell you, because the fish is doing the balancing. Leave it deliberately coarse. Spoon it beside the mackerel rather than over it so the skin stays crisp, and serve both warm. The pairing is old for the same reason it is good: mackerel is rich to the point of cloying by the third mouthful, and a sharp fruit resets the palate every time. If gooseberries are out of season, sharp rhubarb behaves similarly; anything sweeter does not.',
        sensory: {
          identity: 'Fish and sharp fruit. The sauce exists to make the third mouthful as good as the first.',
          aroma: 'Grilled skin dominates; the sauce smells green and faintly floral behind it.',
          balance: 'Deliberately under-sweetened, salt low in the sauce and high on the fish.',
          texture: 'Crisp skin and soft flesh against a coarse, barely-thickened warm sauce.',
          progression: 'Rich and smoky first, then a sharp cut, finishing clean rather than long.',
          failure: 'Sugared to taste in isolation the sauce goes jammy and the plate turns sweet.',
          restraint: 'No herbs, no cream, no vegetable. The plate is two things.',
        },
      },
      {
        authorId: 'fixture/fennel',
        body: 'Force rhubarb, a thumb of ginger and a strip of orange peel, roasted rather than stewed so the pieces hold their shape: quarter-inch batons, a very little sugar, fifteen minutes in a hot oven under foil, then five minutes uncovered. Grate the ginger in at the end rather than the beginning so it stays bright and slightly hot. Serve three or four batons per fish with their syrup, and a spoonful of the fat from the grill pan if there is any. The colour alone justifies it against a grey-brown fish. Where a gooseberry sauce blankets, this stays as distinct pieces, so the mackerel is sharp in some mouthfuls and plain in others, which is a different and in my view better kind of eating.',
        sensory: {
          identity: 'Pieces, not sauce: intermittent sharpness rather than a constant one.',
          aroma: 'Roasted rhubarb and orange peel, with raw ginger lifting off the top.',
          balance: 'Sharp and lightly sweet, with a genuine ginger heat carrying the finish.',
          texture: 'Firm batons that give without collapsing, warm, beside hot crisp skin.',
          progression: 'Fish, then a sudden sharp interruption, then a warm ginger tail.',
          failure: 'Rhubarb stewed instead of roasted collapses into a purée and the idea is lost.',
          restraint: 'No cream and no starch. Nothing on the plate absorbs the syrup.',
        },
      },
      {
        authorId: 'fixture/gale',
        body: 'A cold, sharp cucumber salad, dressed at the last second. Slice cucumber thinly, salt it for ten minutes and squeeze out the water — skip that and the dressing dilutes and the whole thing goes limp on the plate. Fold through crème fraîche loosened with cider vinegar, a decent amount of freshly grated horseradish, and dill. Contains dairy. It should taste of horseradish before it tastes of cream. Serve it cold against the hot fish so the temperature difference does as much work as the flavour does, and keep it in a separate bowl so nobody gets a soggy fish. This is the least fashionable answer of the three and the one I would actually cook on a Tuesday, which seems worth admitting.',
        sensory: {
          identity: 'A cold, hot-tasting salad set against hot, rich fish.',
          aroma: 'Horseradish and dill, with vinegar sitting just underneath.',
          balance: 'Sour and pungent, no sweetness at all, salt drawn out of the cucumber.',
          texture: 'Crisp and cold and slightly slippery against hot crisp skin.',
          progression: 'A cold shock, then heat up the nose, finishing green and clean.',
          failure: 'Unsalted cucumber weeps into the crème fraîche and the salad turns to soup.',
          restraint: 'No sugar, no fruit. The cut is pungency rather than acid alone.',
        },
      },
    ],
  },
  {
    id: 'fx-flavour-004',
    track: 'flavour',
    task: 'A pot of brown lentil soup is cooked through, seasoned, and completely flat. Propose the direction that lifts it, without starting again.',
    judgingQuestion: 'Which bowl would you rather finish?',
    reasons: ['It sounded more delicious', 'It fixed the actual problem', 'It was clearer about how'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'No fermented-ingredient storage advice; miso is added off-heat with no shelf-life claim.' },
    proposals: [
      {
        authorId: 'fixture/gale',
        body: 'Flat almost always means no acid and no browning, so fix both. Take a ladleful of the soup out. In a dry frying pan cook a finely diced onion and a stick of celery hard in oil until there are genuinely dark patches, not golden ones, then add a teaspoon of smoked paprika and a squeeze of tomato purée and let the purée fry until it darkens and stops smelling raw. Deglaze with the reserved ladleful, scrape everything up, tip it back. Then, off the heat, a tablespoon of sherry vinegar, tasted in stages. It will taste too sharp for about a minute and then correct itself as it settles. Salt after the vinegar, never before, because acid changes how much you think you need.',
        sensory: {
          identity: 'The same soup, deepened and cut; no new ingredient announces itself.',
          aroma: 'Smoked paprika and caramelised onion, with vinegar sharp on the steam.',
          balance: 'Acid is the correction; salt is adjusted only after it has gone in.',
          texture: 'Unchanged — thick and homogeneous, hot, no added contrast.',
          progression: 'Rounder opening, savoury middle, a clean sharp finish that resets the spoon.',
          failure: 'Vinegar added over heat boils off and the soup is flat again in ten minutes.',
          restraint: 'No garnish, no cream, no chilli. This is a correction, not a redesign.',
        },
      },
      {
        authorId: 'fixture/hearth',
        body: 'Make a tarka and pour it over each bowl at the table. Heat two tablespoons of ghee or oil until it shimmers, add a teaspoon of cumin seed and wait for it to sizzle and darken by a shade, then mustard seed until it pops, then a dried chilli and eight curry leaves, which will spit. Ten seconds later, off the heat, a pinch of asafoetida if you have it. The whole thing takes ninety seconds and must be poured while it is still audible. Do not stir it in. The soup underneath stays exactly as it was; what changes is that every spoonful passes through a layer of hot spiced fat on the way up. A wedge of lemon on the side does the acid part.',
        sensory: {
          identity: 'An unchanged soup wearing a loud hat; the tarka is the whole intervention.',
          aroma: 'Enormous — curry leaf and toasted cumin arriving before the bowl does.',
          balance: 'Fat and aromatics carry it; acid delegated to a lemon wedge on the side.',
          texture: 'Thick soup under a thin slick of hot fat, with seeds and leaves to bite.',
          progression: 'Aromatic first, earthy through the middle, a mild chilli warmth at the end.',
          failure: 'Cumin taken past a shade darker turns bitter and there is no rescuing it.',
          restraint: 'The soup itself is not touched at all, so nothing can go wrong twice.',
        },
      },
      {
        authorId: 'fixture/juniper',
        body: 'Two tablespoons of white miso, slaked in a little of the hot soup first so it does not sit in lumps, stirred in off the heat. Then fifty grams of butter browned until the solids are the colour of a hazelnut, poured in, and the zest of a whole lemon grated over at the end. The miso brings the savoury depth that long-cooked lentils lose; the browned butter brings the roast note the pot never got; the zest keeps the whole thing from being heavy. Do not boil it after the miso goes in — you lose most of what you added, and it can catch on the base. Taste before salting. Miso is salt, and this is the point where an otherwise good soup usually gets ruined.',
        sensory: {
          identity: 'Deep and rounded, with a citrus edge; least like the soup it started as.',
          aroma: 'Nut-brown butter and lemon oil; the miso is savoury rather than smelt.',
          balance: 'Salt arrives with the miso, so the pot is tasted before anything else is added.',
          texture: 'Slightly richer and glossier, hot, otherwise unchanged.',
          progression: 'Round and savoury, building through the middle, finishing bright and short.',
          failure: 'Boiled after the miso, it flattens again and can catch; take the pot off first.',
          restraint: 'No chilli, no garnish, no cream. Three additions and a strict order.',
        },
      },
    ],
  },
  {
    id: 'fx-flavour-005',
    track: 'flavour',
    task: 'A plain baked custard is going on the table after a long dinner. Propose one aromatic direction, infused rather than stirred in.',
    judgingQuestion: 'Which would you rather be given at the end of that dinner?',
    reasons: ['It sounded more delicious', 'It suited the end of a meal better', 'It was clearer about how'],
    safety: { reviewed: true, reviewer: 'fixture-author', note: 'No raw-egg preparation; all proposals infuse dairy that is subsequently baked. Bay is culinary Laurus nobilis, named as such.' },
    proposals: [
      {
        authorId: 'fixture/juniper',
        body: 'Bay. Bring the cream and milk to just below a simmer with six fresh bay leaves — Laurus nobilis, the culinary one, not ornamental cherry laurel — take it off, cover, and leave it for thirty minutes before straining onto the eggs. It is closer to almond and warm resin than to a stew, and almost nobody identifies it, which is most of the pleasure. Use fewer leaves if they are fresh off a vigorous tree; six dried ones is a different quantity from six fat green ones. Bake as usual in a low oven in a water bath and pull it while the centre still moves. Serve at room temperature rather than fridge-cold, because cold flattens aromatics and you have gone to the trouble of putting one in.',
        sensory: {
          identity: 'A savoury-herbal custard that reads as almond; the source stays unidentified.',
          aroma: 'Warm resin and something almond-like; nothing about it says leaf.',
          balance: 'Barely sweet, no acid, salt just present enough to be noticed if removed.',
          texture: 'Just-set and wobbling, served at room temperature rather than cold.',
          progression: 'Plain cream first, aromatic through the middle, a long cool herbal finish.',
          failure: 'Over-infused it turns medicinal; taste the cream before it meets the eggs.',
          restraint: 'No vanilla. Vanilla would explain the flavour away and it should stay a question.',
        },
      },
      {
        authorId: 'fixture/kelp',
        body: 'Toasted barley. Take fifty grams of pearl barley, toast it dry in a heavy pan until it smells of malt loaf and the grains are properly brown, then infuse it in the hot cream for twenty minutes and strain, pressing hard. What comes out is roasted, faintly bitter and slightly savoury, somewhere near genmaicha, and it does something to a custard that vanilla cannot: it gives it a floor. Do not skip the pressing; most of what you toasted is held in the swollen grain. It wants a pinch more salt than a plain custard and a shorter bake, since the strained cream comes back thinner than it went in. Contains gluten, which matters more here than in most desserts because nobody expects barley in a custard.',
        sensory: {
          identity: 'A roasted, savoury-leaning custard with a distinctly bitter floor.',
          aroma: 'Malt and toast, closer to a hot grain drink than to a dessert.',
          balance: 'Low sweetness, salt slightly raised, bitterness used as structure.',
          texture: 'Marginally looser than a plain custard, served cool but not fridge-cold.',
          progression: 'Toasted and dry on entry, creamy in the middle, a dry bitter finish.',
          failure: 'Under-toasted barley gives a beige, porridgey custard with no floor at all.',
          restraint: 'No sugar increase to compensate. The bitterness is the point of it.',
        },
      },
      {
        authorId: 'fixture/ash',
        body: 'Burnt honey. Cook four tablespoons of honey alone in a small pan until it darkens well past amber and starts to smoke very slightly — it will smell briefly of caramel and then of something harder — then kill it immediately with the hot cream, standing back, because it will erupt. Whisk until smooth, add a wide strip of orange peel, and infuse fifteen minutes before straining onto the eggs. Reduce the sugar in the base by roughly the same volume as the honey. The result is bittersweet rather than sweet and it holds up after a heavy meal, where a sweeter custard would be refused. Take the honey too far and it is genuinely acrid, so have the cream measured and to hand before you start.',
        sensory: {
          identity: 'Bittersweet and dark; the burnt note is the flavour, not an accident.',
          aroma: 'Caramel with an edge of scorch, and orange oil sitting over it.',
          balance: 'Sugar cut to compensate for the honey; bitterness balances what remains.',
          texture: 'Standard set custard, served cool, with no textural addition.',
          progression: 'Sweet on entry, turning bitter and citrus, finishing dry and long.',
          failure: 'A few seconds too long and it is acrid, not bitter; there is no recovery, start again.',
          restraint: 'No vanilla, no spice, no cream on top. One loud idea and an orange peel.',
        },
      },
    ],
  },
];
