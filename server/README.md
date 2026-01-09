# Server

Set `OPENAI_API_KEY` in `server/.env` then run:

```powershell
npm install
npm run dev
```

Endpoints:
- `POST /generate-questions` - body: `{ num, topic }` -> returns `{ questions: [...] }`
- `POST /upload-answer` - multipart form with `video` file and `metadata` field
