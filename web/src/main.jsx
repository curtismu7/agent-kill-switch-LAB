import React from "react";
import { createRoot } from "react-dom/client";
import "./standalone-ui.css";
import "./top-menu/top-menu.css";
import App from "./App.jsx";
import "./app.css";
import "./components/VerifyMark.css";

createRoot(document.getElementById("root")).render(<App />);
