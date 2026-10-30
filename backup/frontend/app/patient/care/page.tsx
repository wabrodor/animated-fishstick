"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Target } from "lucide-react";
import Link from "next/link";
import { Gate, RoleGate } from "@/components/Shell";
import { PatientShell } from "@/components/PatientShell";
import { patientCare } from "@/lib/api";
import type { PatientPortalData } from "@/types/api";
export default function PatientCare() {
  const [data, setData] = useState<PatientPortalData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    patientCare()
      .then(setData)
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "Unable to load your care plan.",
        ),
      );
  }, []);
  return (
    <Gate fallbackPath="/patient/login">
      <RoleGate allowed={["PATIENT"]}>
        <PatientShell
          title="My care"
          subtitle="Your plan, goals and next steps."
        >
          <Link className="muted back-link" href="/patient">
            <ArrowLeft size={14} /> Home
          </Link>
          {error && <div className="card glass alert-error">{error}</div>}
          {!data ? (
            <div className="card glass skeleton-card" />
          ) : (
            <>
              <div className="grid g2 section">
                {data.plan && (
                  <div className="card glass page-enter">
                    <div className="section-head">
                      <div>
                        <div className="eyebrow">Care plan</div>
                        <h2>{data.plan.condition.replaceAll("_", " ")}</h2>
                      </div>
                      <Target size={20} />
                    </div>
                    <p className="muted">
                      Your clinician-approved care plan is active.
                    </p>
                    {data.plan.goals.map((goal, i) => (
                      <div
                        className="signal-list-row"
                        key={`${goal.title}-${i}`}
                      >
                        <div>
                          <b>{goal.title}</b>
                          <span>
                            {goal.target ||
                              "Keep working on this goal consistently."}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="card glass page-enter">
                  <div className="section-head">
                    <div>
                      <div className="eyebrow">Progress</div>
                      <h2>
                        {data.completedTasks}/{data.totalTasks} completed
                      </h2>
                    </div>
                    <CheckCircle2 size={20} />
                  </div>
                  <p className="muted">
                    Completing small tasks helps your clinical team understand
                    how your care is going.
                  </p>
                </div>
              </div>
              <div className="card glass section page-enter">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Task history</div>
                    <h2>All care tasks</h2>
                  </div>
                </div>
                {data.tasks.map((task) => (
                  <div className="signal-list-row" key={task._id}>
                    <div>
                      <b>{task.title}</b>
                      <span>
                        {new Date(task.dueAt).toLocaleDateString()} •{" "}
                        {task.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    {task.status === "COMPLETED" && <CheckCircle2 size={17} />}
                  </div>
                ))}
              </div>
            </>
          )}
        </PatientShell>
      </RoleGate>
    </Gate>
  );
}
