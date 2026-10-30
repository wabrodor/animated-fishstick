'use client';

type ProgressSummary = {
  patientId?: string;
  generatedAt?: string;

  dataWindow?: {
    from?: string;
    to?: string;
  };

  vitals?: {
    bloodPressureReadings?: number;

    latestBloodPressure?: {
      systolic?: number;
      diastolic?: number;
      recordedAt?: string;
    };

    averageBloodPressure?: {
      systolic?: number;
      diastolic?: number;
    };

    latestWeightKg?: number;
    weightChangeKg?: number;
  };

  opd?: {
    visitCount?: number;
    lastVisitAt?: string;
  };

  tasks?: {
    total?: number;
    completed?: number;
    overdue?: number;
    completionRate?: number;
  };

  [key: string]: unknown;
};

function formatDate(value?: string) {
  if (!value) return '—';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleDateString();
}

function formatPercent(value?: number) {
  if (value === undefined || value === null) {
    return '—';
  }

  return `${Math.round(value)}%`;
}

export function ClinicalProgressSummary({
  summary,
}: {
  summary: Record<string, unknown>;
}) {
  const data =
    summary as ProgressSummary;

  const latestBP =
    data.vitals?.latestBloodPressure;

  const averageBP =
    data.vitals?.averageBloodPressure;

  const tasks =
    data.tasks;

  const opd =
    data.opd;

  return (
    <section className="clinical-summary">

      {/* =====================================================
          HEADER
          ===================================================== */}

      <div className="clinical-summary-header">
        <div>
          <div className="eyebrow">
            Clinical progress
          </div>

          <h2>
            Patient progress
          </h2>

          <p className="muted">
            Available clinical information across the
            current observation window.
          </p>
        </div>

        <div className="clinical-summary-window">
          <span>
            Observation window
          </span>

          <strong>
            {formatDate(
              data.dataWindow?.from,
            )}{' '}
            –{' '}
            {formatDate(
              data.dataWindow?.to,
            )}
          </strong>
        </div>
      </div>

      {/* =====================================================
          KEY METRICS
          ===================================================== */}

      <div className="clinical-summary-grid">

        <div className="clinical-summary-metric">
          <span>
            Latest BP
          </span>

          <strong>
            {latestBP
              ? `${latestBP.systolic ?? '—'}/${latestBP.diastolic ?? '—'}`
              : '—'}
          </strong>

          <small>
            {latestBP?.recordedAt
              ? formatDate(
                  latestBP.recordedAt,
                )
              : 'No reading'}
          </small>
        </div>

        <div className="clinical-summary-metric">
          <span>
            Average BP
          </span>

          <strong>
            {averageBP
              ? `${averageBP.systolic ?? '—'}/${averageBP.diastolic ?? '—'}`
              : '—'}
          </strong>

          <small>
            From available readings
          </small>
        </div>

        <div className="clinical-summary-metric">
          <span>
            BP readings
          </span>

          <strong>
            {data.vitals
              ?.bloodPressureReadings ??
              '—'}
          </strong>

          <small>
            Available records
          </small>
        </div>

        <div className="clinical-summary-metric">
          <span>
            OPD visits
          </span>

          <strong>
            {opd?.visitCount ??
              '—'}
          </strong>

          <small>
            Last:{' '}
            {formatDate(
              opd?.lastVisitAt,
            )}
          </small>
        </div>

      </div>

      {/* =====================================================
          TASK PROGRESS
          ===================================================== */}

      {tasks && (
        <div className="clinical-summary-section">

          <div className="section-head">
            <h3>
              Care task progress
            </h3>

            <span className="muted">
              {formatPercent(
                tasks.completionRate,
              )}
            </span>
          </div>

          <div className="clinical-task-grid">

            <div>
              <span>
                Total
              </span>

              <strong>
                {tasks.total ?? '—'}
              </strong>
            </div>

            <div>
              <span>
                Completed
              </span>

              <strong className="success-text">
                {tasks.completed ?? '—'}
              </strong>
            </div>

            <div>
              <span>
                Overdue
              </span>

              <strong className="danger-text">
                {tasks.overdue ?? '—'}
              </strong>
            </div>

          </div>

        </div>
      )}

      {/* =====================================================
          WEIGHT
          ===================================================== */}

      {(data.vitals?.latestWeightKg !== undefined ||
        data.vitals?.weightChangeKg !== undefined) && (
        <div className="clinical-summary-section">

          <div className="section-head">
            <h3>
              Weight
            </h3>
          </div>

          <div className="clinical-weight-row">

            {data.vitals.latestWeightKg !==
              undefined && (
              <div>
                <span>
                  Latest
                </span>

                <strong>
                  {
                    data.vitals
                      .latestWeightKg
                  }{' '}
                  kg
                </strong>
              </div>
            )}

            {data.vitals.weightChangeKg !==
              undefined && (
              <div>
                <span>
                  Change
                </span>

                <strong>
                  {data.vitals
                    .weightChangeKg > 0
                    ? '+'
                    : ''}
                  {
                    data.vitals
                      .weightChangeKg
                  }{' '}
                  kg
                </strong>
              </div>
            )}

          </div>

        </div>
      )}

      {/* =====================================================
          FOOTNOTE
          ===================================================== */}

      <div className="clinical-summary-footnote">
        Generated{' '}
        {formatDate(
          data.generatedAt,
        )}{' '}
        from available structured clinical records.
      </div>

    </section>
  );
}