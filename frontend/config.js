// Use the local API during development and the Render API in production.
window.API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
	? "http://localhost:4000"
	: "https://adaptive-fit-api.onrender.com";
