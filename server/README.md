# Server

Copy `server/env.example` to `server/.env` and set:
- `DATABASE_URL` (PostgreSQL connection string)
- `OPENAI_API_KEY` (for question generation + evaluation)

Then run:

```powershell
npm install
npm run dev
```

If you have existing data in `server/records.json`, migrate it into PostgreSQL:

```powershell
npm run migrate:records-json
```

Endpoints:
- `POST /generate-questions` - body: `{ num, topic }` -> returns `{ questions: [...] }`
- `POST /upload-answer` - multipart form with `video` file and `metadata` field
