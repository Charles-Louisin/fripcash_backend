# FripCash API (Express + MongoDB)

```bash
# Mongo local (docker si disponible)
docker compose up -d

cd backend
cp .env.example .env
npm install
npm run seed
npm run dev
```

API : `http://localhost:5000/api/v1`

Comptes seed (`Password123!`) :

- `admin@fripcash.test`
- `buyer@fripcash.test`
- `seller@fripcash.test`
- `courier@fripcash.test`
- OTP Guinée : `+224620000001` / `000000`
