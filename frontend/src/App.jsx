import { useState } from "react";
import SubmissionForm from "./SubmissionForm";
import SubmissionList from "./SubmissionList";
import TrackSubmission from "./TrackSubmission";
import "./App.css";

export default function App() {
  const [view, setView] = useState("submit"); // "submit" | "browse" | "track"
  const [refreshKey, setRefreshKey] = useState(0);

  function handleSubmitted() {
    // Refresh the list so it is current when the user goes to Browse, but stay
    // on the form: the submitter still has to read and copy their tracking
    // code, and navigating away would hide it before they can.
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <span className="app-header-eyebrow">Student Affairs</span>
          <h1>Grievance Redressal</h1>
          <p className="app-header-subtitle">
            Submit, track and resolve campus complaints and service requests.
          </p>
        </div>
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
          <button
            className={view === "track" ? "active" : ""}
            onClick={() => setView("track")}
          >
            Track
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === "submit" && <SubmissionForm onSubmitted={handleSubmitted} />}
        {view === "browse" && <SubmissionList refreshKey={refreshKey} />}
        {view === "track" && <TrackSubmission />}
      </main>
    </div>
  );
}
