from app.scoring.uncertainty import bootstrap_confidence_interval


def test_bootstrap_interval_widens_when_clusters_disagree() -> None:
    agreeing = bootstrap_confidence_interval(
        cluster_groups=[[0.58, 0.6], [0.59, 0.61]],
        judge_probabilities=[0.59, 0.6, 0.61],
        num_samples=300,
        seed=7,
    )
    disagreeing = bootstrap_confidence_interval(
        cluster_groups=[[0.2, 0.25], [0.8, 0.85]],
        judge_probabilities=[0.25, 0.5, 0.8],
        num_samples=300,
        seed=7,
    )

    agreeing_width = agreeing.high - agreeing.low
    disagreeing_width = disagreeing.high - disagreeing.low

    assert disagreeing_width > agreeing_width
