# Say It

Voice and text calorie log. Say what you ate; saved foods use your exact published macros, everything else is broken into ingredients, priced from USDA FoodData Central, and shown with a likely range.

- Front end: `index.html` (static, GitHub Pages)
- Backend: Supabase (Postgres with row-level security, edge functions `meal` and `transcribe`)
- Parsing: Claude Haiku 5.5 via the Anthropic API
- Voice: Whisper on Groq when `GROQ_API_KEY` is set, otherwise the browser's speech recognition

Nutrition data: U.S. Department of Agriculture, Agricultural Research Service. FoodData Central.
