import React from "react";
import { createRoot } from "react-dom/client";
import "./standalone-ui.css";
import App from "./App.jsx";
import "./styles/standalone-ui.css";
import "./app.css";
import "./fedid.css";

createRoot(document.getElementById("root")).render(<App />);
