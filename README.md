# Running the Project

This project uses JavaScript ES Modules (`.mjs`).

## Requirements

- [Node.js](https://nodejs.org/) (includes `npx`)

## Run the Project

1. Open a terminal in the project folder.

2. Start the local web server:
```bash
npx serve
```

3. Open your browser and go to the local address printed in the terminal (by default):
```
http://localhost:3000
```
4. The `main.html` file will be loaded automatically.

## Important

Do not open `main.html` directly using:

```
file:///...
```

The project uses ES Modules (`.mjs`), which require the files to be served through a local web server.

## Stop the Server

To stop the server, press:

```
Ctrl + C
```