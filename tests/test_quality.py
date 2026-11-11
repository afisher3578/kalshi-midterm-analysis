import datetime as dt

from raceattn.metrics.quality import compute_quality, worst

DAYS = [dt.date(2026, 9, 1) + dt.timedelta(days=i) for i in range(40)]


def series(vals):
    return {d: v for d, v in zip(DAYS, vals)}


def test_full_series_ok():
    q = compute_quality(series([100.0] * 40), DAYS)
    assert q.status == "ok" and q.coverage_days == 40 and q.window_days == 40
    assert q.missing_days == [] and q.longest_gap == 0 and q.near_zero == [] and q.reasons == []


def test_missing_days_and_longest_gap():
    vals = [100.0] * 40
    for i in (3, 10, 11, 12, 13, 30):
        vals[i] = None
    q = compute_quality(series(vals), DAYS)
    assert q.coverage_days == 34
    assert q.missing_days == [DAYS[i].isoformat() for i in (3, 10, 11, 12, 13, 30)]
    assert q.longest_gap == 4
    assert q.status == "degraded"  # 85% coverage and a 4 day gap


def test_absent_keys_count_as_missing():
    q = compute_quality({DAYS[0]: 5.0}, DAYS[:3])
    assert q.missing_days == [DAYS[1].isoformat(), DAYS[2].isoformat()]


def test_unusable_low_coverage():
    vals = [100.0 if i % 2 == 0 else None for i in range(40)]
    q = compute_quality(series(vals), DAYS)
    assert q.status == "unusable" and "coverage" in q.reasons[0]


def test_no_data_unusable():
    q = compute_quality({}, DAYS)
    assert q.status == "unusable" and q.reasons == ["no data in the window"]


def test_near_zero_stretch_detected():
    vals = [100.0] * 40
    vals[20], vals[21] = 2.0, 0.0
    q = compute_quality(series(vals), DAYS)
    assert len(q.near_zero) == 1
    nz = q.near_zero[0]
    assert nz["start"] == DAYS[20].isoformat() and nz["end"] == DAYS[21].isoformat() and nz["days"] == 2
    assert q.status == "degraded"


def test_near_zero_many_days_unusable():
    vals = [100.0] * 40
    for i in range(10, 16):
        vals[i] = 1.0
    q = compute_quality(series(vals), DAYS)
    assert q.status == "unusable"


def test_near_zero_needs_normal_neighbor():
    # uniformly tiny series has no stretch relative to its own median
    q = compute_quality(series([1.0] * 40), DAYS)
    assert q.near_zero == []


def test_near_zero_across_gap_uses_nearest_present_neighbor():
    vals = [100.0] * 40
    vals[5] = None
    vals[6] = 0.0
    q = compute_quality(series(vals), DAYS)
    assert [n["start"] for n in q.near_zero] == [DAYS[6].isoformat()]


def test_near_zero_can_be_disabled():
    vals = [100.0] * 40
    vals[20] = 0.0
    assert compute_quality(series(vals), DAYS, check_near_zero=False).near_zero == []


def test_gdelt_like_pilot_series_is_unusable():
    # pilot GDELT: 44 of 65 days with near-zero values before the election
    days = [dt.date(2026, 9, 1) + dt.timedelta(days=i) for i in range(65)]
    vals = [80.0] * 65
    for i in list(range(13, 19)) + list(range(32, 35)) + list(range(57, 63)) + [40, 41, 42, 50, 51, 52]:
        vals[i] = None
    vals[54], vals[55], vals[56] = 2.0, 2.0, 0.0
    q = compute_quality({d: v for d, v in zip(days, vals)}, days)
    assert q.coverage_days == 44 and q.status == "unusable"


def test_worst():
    assert worst("ok", "degraded") == "degraded"
    assert worst("unusable", "ok", "degraded") == "unusable"
