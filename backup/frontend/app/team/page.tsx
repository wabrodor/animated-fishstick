"use client";
import { Shell, Gate, RoleGate } from "@/components/Shell";
import { Users, HeartPulse, Stethoscope } from "lucide-react";
export default function Team() {
  return (
    <Gate>
      <RoleGate allowed={["CLINIC_ADMIN"]}>
      <Shell
        title="Care team"
        subtitle="Roles and service boundaries for the clinic workflow."
      >
        <div className="grid g3">
          <div className="card glass">
            <Users color="#1677ff" />
            <h2>Clinicians</h2>
            <p className="muted">
              Diagnose hypertension, review AI drafts, approve care plans,
              record OPD visits and initiate ApexCare service requests.
            </p>
          </div>
          <div className="card glass">
            <HeartPulse color="#1677ff" />
            <h2>Coordinators</h2>
            <p className="muted">
              Run the operational queue, coordinate patient follow-up and help
              patients complete requested ApexCare consultations.
            </p>
          </div>
          <div className="card glass">
            <Stethoscope color="#1677ff" />
            <h2>ApexCare services</h2>
            <p className="muted">
              Dietitian and endocrinology services are provided by ApexCare.
              Clinic coordinators do not clinically create or approve these
              requests.
            </p>
          </div>
        </div>
      </Shell>
        </RoleGate>
    </Gate>
  );
}
