from app.scoring.weights import default_judge_weights, select_regime, update_expert_weights


def test_select_regime_uses_planned_thresholds() -> None:
    assert select_regime(0) == "cold_start"
    assert select_regime(19) == "cold_start"
    assert select_regime(20) == "warming"
    assert select_regime(99) == "warming"
    assert select_regime(100) == "steady"


def test_default_judge_weights_are_uniform() -> None:
    weights = default_judge_weights(
        ["official_records", "community_signal", "open_web_research"]
    )

    assert weights == {
        "official_records": 1 / 3,
        "community_signal": 1 / 3,
        "open_web_research": 1 / 3,
    }


def test_cold_start_does_not_update_weights() -> None:
    current = {"official_records": 0.4, "community_signal": 0.3, "open_web_research": 0.3}
    regrets = {"official_records": 0.1, "community_signal": 0.4, "open_web_research": 0.6}

    updated = update_expert_weights(current, regrets, resolved_outcome_count=5)

    assert updated == current


def test_steady_weights_move_toward_lower_regret_judges() -> None:
    current = {"official_records": 1 / 3, "community_signal": 1 / 3, "open_web_research": 1 / 3}
    regrets = {"official_records": 0.1, "community_signal": 0.9, "open_web_research": 0.5}

    updated = update_expert_weights(current, regrets, resolved_outcome_count=120)

    assert updated["official_records"] > current["official_records"]
    assert updated["community_signal"] < current["community_signal"]
    assert round(sum(updated.values()), 8) == 1.0
