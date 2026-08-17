# Friday Quiz has no dependencies and no build step, so this is the whole image.
FROM node:22-alpine

WORKDIR /app
COPY . .

# Accounts, history and uploaded media live here. Mount a persistent volume at
# this path - anything written elsewhere in the container is lost on redeploy.
ENV QUIZ_DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
