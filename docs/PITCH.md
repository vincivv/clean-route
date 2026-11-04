# 2-minute pitch

**Before you go up:** open the app and run the demo route once. Allow location if you want to route from where you are. Keep `docs/demo/backup_voice_clip.wav` ready in case the mic fails (it's a synthetic voice, so say so if you play it).

**Best demo route right now:** 33 New Montgomery to Dolores Park, which starts at the venue. At 6:54 PM it showed 97% less pollen and 47% less traffic pollution for 4.3 more minutes. Traffic changes those numbers, so read them from the screen.

**November moment:** no trees are in season today, so the circles are dim. Choose "Plan for another month", pick April, and show them turn red. Say out loud that you're planning for April.

**0:00 Who (20 sec).** "One in five or so of us gets hit by pollen each spring. Your maps app can't help, because it doesn't know that the London planes on Market Street are what sets you off. SF has 138,000 mapped street trees, but no data on which ones trigger allergies." *(Check this first figure or drop it: it's from memory, not our data.)*

**0:20 Demo (35 sec).** Speak: "I'm allergic to sycamore and olive, and I have asthma." Show the chips: Mistral mapped sycamore to plane trees. Search Dolores Park. "Today the circles are dim, because nothing's in season. Planning for April, they turn red. It routes me around them, and because I have asthma, around traffic too, using live TomTom congestion." *(Read the percentages and minutes from the screen.)*

**0:55 Honest number (15 sec).** "That's one of the best examples. Across 100 asthma walks, the median is 37% less estimated traffic pollution and 64% less pollen exposure counting trees within 25 metres, or 19% within 100, for about 2 extra minutes."

**1:10 Elastic (25 sec).** Open "Show the Elastic query". "Elastic scored all 32,000 street segments against 60,000 trees with geo_shape and sum aggregations. These circles are live geotile_grid aggregations. This aggregation proves each route. Search is fuzzy autocomplete over 57,000 places, and symptom search is hybrid with Mistral embeddings. Elastic does the math, not the LLM."

**1:35 Mistral (15 sec).** "Large 4 built the allergen table the city doesn't have, for 122 species. We then checked it against a published reference, and Mistral matched exactly on under half, so the published rating wins. Voxtral does the voice, and a small model turns it into a profile."

**1:50 Limits (10 sec).** "This is estimated exposure from street trees, not live pollen, and not medical advice. Next: add parks and clinical data."

## If judges ask

- **Which algorithm?** Dijkstra with our own cost function, swept over 12 exposure prices with a detour limit. Elastic supplies the scores and the proof; it doesn't find paths. Scores are synced to memory every 10 minutes for speed.
- **How accurate?** Tree data is city records. Elastic's totals match an independent count (436 vs 441 trees). Ratings were checked against one source, Pollen Library: 69% of exposure weight has a species-level published rating, 7% a close relative's, and 24% is Mistral alone. Bloom months aren't validated.
- **Doesn't pollen travel for miles?** Yes. We only reduce nearby sources, which is why we show the 100 m figure too, and it's much smaller: 19% vs 64% on the asthma test. We can't claim fewer symptoms.
- **Car pollution?** It's our own uncalibrated score: road class, live TomTom congestion and SF's exposure zone. Congestion is speed, not a car count, and none of this measures emissions.
- **Why not ChatGPT?** It can't compute distinct allergen-weighted trees across 32,000 street segments, or route through them.
