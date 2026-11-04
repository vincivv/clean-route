# 2-minute pitch

**Before you go up:** open the app and run the demo route once. Allow location if you want to route from where you are. Keep `docs/demo/backup_voice_clip.wav` ready in case the mic fails (it's a synthetic voice, so say so if you play it).

**November catch:** no trees are in season today, so the app says that first. For the demo, choose "Plan for another month" and pick April, and say so out loud.

**0:00 Who (20 sec).** "One in five or so of us gets hit by pollen each spring. Your maps app can't help, because it doesn't know that the London planes on Market Street are what sets you off. SF has 138,000 mapped street trees, but no data on which ones trigger allergies." *(Check this first figure or drop it: it's from memory, not our data.)*

**0:20 Demo (35 sec).** Speak: "I'm allergic to sycamore and olive, and I have asthma." Show the chips: Mistral mapped sycamore to plane trees. Choose Ferry Building to Civic Center. "Planning for April, it moves me off Market Street's plane trees, and because I have asthma, it also avoids live traffic." *(Read the percentage and minutes from the screen. They change with live traffic, and this route can add around 10 minutes, so run it first and pick another preset if that looks too long.)*

**0:55 Honest number (15 sec).** "That's one of the better examples. Across 200 random walks, the median is 72% counting trees within 25 metres, but 22% within 100, for about 2 extra minutes. For asthma, a 60-walk test on live traffic halved heavy-traffic walking, from 464 to 232 metres."

**1:10 Elastic (25 sec).** Open "Show the Elastic query". "Elastic scored all 32,000 street segments against 60,000 trees with geo_shape and sum aggregations. Routes use those scores, synced from Elastic, and this live aggregation proves each result. Elastic does the math, not the LLM. Symptom search is hybrid: BM25 plus Mistral embeddings."

**1:35 Mistral (15 sec).** "Large 4 built the allergen table the city doesn't have, for 122 species. We then checked it against a published reference, and Mistral matched exactly on under half, so the published rating wins. Voxtral does the voice, and a small model turns it into a profile."

**1:50 Limits (10 sec).** "This is estimated exposure from street trees, not live pollen, and not medical advice. Next: add parks and clinical data."

## If judges ask

- **Which algorithm?** Dijkstra with our own cost function, swept over 12 exposure prices with a detour limit. Elastic supplies the scores and the proof; it doesn't find paths. Scores are synced to memory every 10 minutes for speed.
- **How accurate?** Tree data is city records. Elastic's totals match an independent count (436 vs 441 trees). Ratings were checked against one source, Pollen Library: 69% of exposure weight has a species-level published rating, 7% a close relative's, and 24% is Mistral alone. Bloom months aren't validated.
- **Doesn't pollen travel for miles?** Yes. We only reduce nearby sources, which is why we show the 100 m figure too, and it's much smaller: 22% vs 72%. We can't claim fewer symptoms.
- **Car pollution?** We use live TomTom congestion if the key is set, plus road type and SF's exposure zone. Congestion is speed, not a car count, and none of this measures emissions.
- **Why not ChatGPT?** It can't compute distinct allergen-weighted trees across 32,000 street segments, or route through them.
