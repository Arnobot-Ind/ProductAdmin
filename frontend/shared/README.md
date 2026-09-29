# shared

A copy of `backend/src/shared` (the API types and constants), so the frontend builds on its own
(Netlify deploys the `frontend` branch, which has no `backend/` folder).

When the backend's `src/shared` changes, copy it here again:

```bash
cp ../backend/src/shared/{constants,dto,index,messages,status}.ts shared/
```
