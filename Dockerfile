# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app/server

# Copy package.json and package-lock.json (if available)
COPY claude-prompts-mcp/server/package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY claude-prompts-mcp/server/ .

# Build the TypeScript project
RUN npm run build

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the app
CMD ["npm", "run", "start"]
