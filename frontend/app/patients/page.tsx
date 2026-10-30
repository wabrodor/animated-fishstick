"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, RefreshCw, Search, Users } from "lucide-react";
import { Shell, Gate } from "@/components/Shell";
import { patients } from "@/lib/api";
import type { Patient } from "@/types/api";

export default function Patients() {
  const [data, setData] = useState<Patient[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      setData(await patients());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load patients.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const list = useMemo(
    () =>
      data?.filter((p) =>
        `${p.name.first} ${p.name.last ?? ""} ${p.medicalRecordNumber ?? ""} ${p.phone ?? ""}`
          .toLowerCase()
          .includes(q.toLowerCase().trim()),
      ) || [],
    [data, q],
  );

  return (
    <Gate>
      <Shell title="Patients" subtitle="Your clinic's active chronic-care population.">
        <section className="card glass page-enter">
          <div className="section-head">
            <div>
              <div className="eyebrow">Patient registry</div>
              <h2>People in your care</h2>
              <span className="muted">Search by name, MRN or phone. Access remains controlled by the backend.</span>
            </div>
            <button className="secondary icon-button" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh patients">
              <RefreshCw size={15} className={refreshing ? "button-spinner" : ""} />
              <span className="desktop-only">Refresh</span>
            </button>
          </div>

          <div className="search">
            <Search size={17} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patients or MRN…" aria-label="Search patients" />
          </div>

          {error ? (
            <div className="alert alert-error page-enter" role="alert">
              <b>We couldn't load the patient list.</b>
              <p>{error}</p>
              <button className="secondary" onClick={() => void load(true)}>Try again</button>
            </div>
          ) : !data ? (
            <div className="skeleton-list" aria-label="Loading patients">
              {Array.from({ length: 5 }).map((_, i) => <div className="skeleton-row" key={i} />)}
            </div>
          ) : list.length === 0 ? (
            <div className="empty-state page-enter">
              <div className="empty-icon"><Users size={20} /></div>
              <b>{q ? "No matching patients" : "No active patients yet"}</b>
              <span>{q ? "Try a different name, MRN or phone number." : "Newly registered patients will appear here."}</span>
            </div>
          ) : (
            <div className="patient-list page-enter">
              {list.map((p, index) => (
                <Link className="row patient-row" href={`/patients/${p._id}`} key={p._id} style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
                  <div className="person">
                    <div className="avatar">{p.name.first[0]}{p.name.last?.[0]}</div>
                    <div>
                      <b>{p.name.first} {p.name.last}</b>
                      <span>{p.medicalRecordNumber || "No MRN"} · {p.phone || "No phone"}</span>
                    </div>
                  </div>
                  <span className="badge blue">{(p.enrollmentStatus || "NOT_ENROLLED").replaceAll("_", " ")}</span>
                  <span className="muted">{p.conditions?.map((x) => x.code.replaceAll("_", " ")).join(", ") || "No diagnosis"}</span>
                  <ArrowUpRight size={15} />
                </Link>
              ))}
            </div>
          )}
        </section>
      </Shell>
    </Gate>
  );
}
