import { useState } from "react";
import SubmissionForm from "./SubmissionForm";
import SubmissionList from "./SubmissionList";
import "./App.css";

export default function App() {
  const [view, setView] = useState("submit"); // "submit" | "browse"
  const [refreshKey, setRefreshKey] = useState(0);

  function handleSubmitted() {
    setRefreshKey((k) => k + 1);
    setView("browse");
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Grievance Redressal</h1>
        <nav>
          <button
            className={view === "submit" ? "active" : ""}
            onClick={() => setView("submit")}
          >
            Submit
          </button>
          <button
            className={view === "browse" ? "active" : ""}
            onClick={() => setView("browse")}
          >
            Browse
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === "submit" ? (
          <SubmissionForm onSubmitted={handleSubmitted} />
        ) : (
          <SubmissionList refreshKey={refreshKey} />
        )}
      </main>
    </div>
  );
}
