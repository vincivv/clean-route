# 2-minute pitch

**Before you go up:** open the app, select the Ferry Building preset once so it's cached, and open `docs/demo/backup_voice_clip.wav` in case the mic fails (it's a synthetic voice, so say so if you play it).

**0:00 Who (20 sec).** "One in five or so of us gets hit by pollen each spring. Your maps app can't help, because it doesn't know that the London planes on Market Street are what sets you off. SF has 138,000 mapped street trees, but no data on which ones trigger allergies." *(Check this first figure or drop it: it's from memory, not our data.)*

**0:20 Demo (35 sec).** Speak: "I'm allergic to sycamore and olive, and I have asthma." Show the chips: Mistral mapped sycamore to plane trees. Choose Ferry Building to Civic Center. "It moves me off Market Street's plane trees onto Mission Street. This walk is 87% less estimated exposure for 4.7 more minutes." *(Read the numbers on screen, since they depend on the profile.)*

**0:55 Honest number (15 sec).** "That's one of the better examples. Across 30 random walks, the median is 74% counting trees within 25 metres, but 20% within 100, for about 2.5 extra minutes."

**1:10 Elastic (25 sec).** Open "Show the Elastic query". "Elastic scored all 32,000 street segments against 60,000 trees with geo_shape and sum aggregations. Every route loads its corridor from Elastic, and this live aggregation proves the result. Elastic does the math, not the LLM. Symptom search is hybrid: BM25 plus Mistral embeddings."

**1:35 Mistral (15 sec).** "Large 4 built the allergen table the city doesn't have, for 122 species. We then checked it against a published reference, and Mistral matched exactly on under half, so the published rating wins. Voxtral does the voice, and a small model turns it into a profile."

**1:50 Limits (10 sec).** "This is estimated exposure from street trees, not live pollen, and not medical advice. Next: add parks and clinical data."

## If judges ask

- **Which algorithm?** Dijkstra with our own cost function, swept over 12 exposure prices with a detour limit. Elastic supplies the scores and the proof; it doesn't find paths.
- **How accurate?** Tree data is city records. Elastic's totals match an independent count (436 vs 441 trees). Ratings were checked against one source, Pollen Library: 69% of exposure weight has a species-level published rating, 7% a close relative's, and 24% is Mistral alone. Bloom months aren't validated.
- **Doesn't pollen travel for miles?** Yes. We only reduce nearby sources, which is why we show the 100 m figure too, and it's much smaller: 20% vs 74%. We can't claim fewer symptoms.
- **Car pollution?** Road type and SF's exposure zone are stand-ins. There's no live emissions data.
- **Why not ChatGPT?** It can't compute distinct allergen-weighted trees across 32,000 street segments, or route through them.
