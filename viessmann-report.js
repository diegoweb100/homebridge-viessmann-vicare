#!/usr/bin/env node
/**
 * Viessmann History Report Generator
 * Reads viessmann-history.csv and generates an interactive HTML report
 * with Chart.js graphs (no extra dependencies — Chart.js loaded via CDN).
 *
 * Usage:
 *   node viessmann-report.js --installation 2045571
 *   node viessmann-report.js --installation 2045571 --days 7
 *   node viessmann-report.js --installation 2045571 --days 30 --out /tmp/report.html
 *
 * --installation <ID>  Installation ID (creates viessmann-history-<ID>.csv)
 * --days <N>           Number of days to include (default: 7)
 * --path <dir>         Homebridge storage path (default: /var/lib/homebridge)
 * --out <file>         Output HTML file path
 *
 * No extra dependencies needed — open the generated HTML in any browser.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? args[i+1] : def; };
const DAYS = parseInt(getArg('--days', '7'), 10);
const LANG = getArg('--lang', process.env.REPORT_LANG || 'en').toLowerCase();

// ═══════════════════════════════════════════════════════════════════════════
// i18n — Internationalization
// Add new languages by extending the STRINGS object below.
// Supported: 'en' (default), 'it'
// Usage: --lang it  or  env REPORT_LANG=it
// ═══════════════════════════════════════════════════════════════════════════
const STRINGS = {
  en: {
    // ── Section titles ──────────────────────────────────────────────────
    reportTitle:        'Viessmann ViCare — History Report',
    sectionOverview:    '📈 Overview',
    sectionBoiler:      '🔥 Boiler — Burner',
    sectionHC0:         '🌡️ Heating Circuit (HC0)',
    sectionSystemAnalysis: '🔍 System Analysis',
    sectionDHW:         '🚿 Domestic Hot Water (DHW)',
    sectionEnergySummary: '📊 Energy Summary (from Viessmann API)',
    sectionEnergySystem: '⚡ Energy System (PV / Battery / Grid)',
    sectionGasForecast: '⛽ Gas Forecast',
    sectionDeviceMessages: '🔔 Device Messages',

    // ── KPI labels ──────────────────────────────────────────────────────
    cyclesInPeriod:     'CYCLES IN PERIOD',
    startsPerHour:      'STARTS/HOUR',
    avgCycleDuration:   'AVG CYCLE DURATION',
    burnerRuntime:      'BURNER RUNTIME',
    lifetimeStarts:     'LIFETIME STARTS',
    lifetimeHours:      'LIFETIME HOURS',
    avgModulation:      'AVG MODULATION (ACTIVE)',
    maxModulation:      'MAX MODULATION',
    avgHeatDemand:      'AVG HEAT DEMAND',
    gasHeatingToday:    'GAS HEATING TODAY',
    gasDhwToday:        'GAS DHW TODAY',
    gasTotalToday:      'GAS TOTAL TODAY',
    avgRoomTemp:        'AVG ROOM TEMP',
    avgSetpoint:        'AVG SETPOINT',
    maxFlowTemp:        'MAX FLOW TEMP',
    condensingMode:     'CONDENSING MODE',
    avgFlowTemp:        'AVG FLOW TEMP',
    todaySchedule:      "TODAY'S SCHEDULE",
    programDist:        'PROGRAM DISTRIBUTION',
    heatLossCoeff:      'HEAT LOSS COEFF.',
    estPeakLoad:        'EST. PEAK LOAD',
    boilerNominal:      'BOILER NOMINAL',
    houseEfficiency:    'HOUSE EFFICIENCY',
    cyclingScore:       'CYCLING SCORE',
    comfortStability:   'COMFORT STABILITY',
    estEfficiency:      'EST. EFFICIENCY',
    heatingCurveLabel:  'HEATING CURVE',

    // ── Ratings ─────────────────────────────────────────────────────────
    condensing:         'Condensing ✓',
    excellent:          'Excellent',
    good:               'Good',
    average:            'Average',
    poor:               'Poor',
    oversized:          'Oversized',
    weatherComp:        'Weather-compensated ✓',
    fixedFlow:          'Fixed flow temp',
    checkCurve:         'Check curve config',
    atOutdoor:          'at {temp}°C outdoor',

    // ── Chart notes ─────────────────────────────────────────────────────
    cycleApiNote:       'Cycle count uses <strong>API firmware counters</strong> (burner_starts delta) — captures all ignitions regardless of 15-min CSV sample rate. CSV edge detection would miss ~{pct}% of cycles at this cycle frequency.',
    burnerBarsNote:     'Burner ON/OFF bars show only cycles visible within 15-min sampling interval. Actual cycle count ({n}) is {mult}× higher — see API counter KPIs above.',
    histNote:           'Distribution of burner ON durations visible in CSV samples. Actual cycle duration from API counters: avg {dur} min. Histogram shows only ~{vis} of {real} real cycles.',
    flowTempNote:       'Flow temperature (supply) — proxy for condensing efficiency. Below 55°C = condensing range.',
    heatDemandTitle:    'Heat Demand vs Outdoor Temperature',
    heatDemandNote:     'Each point = one burner-active sample. Red line = linear regression.{bp} <em>Scroll to zoom · Drag to pan · Double-click to reset.</em>',
    balancePoint:       ' Balance point (estimated): {bp}°C outdoor.',
    flowCurveTitle:     '🌡️ Flow Temperature vs Outdoor — Actual vs Heating Curve',
    flowCurveNote:      'Blue dots = measured flow temp when burner active. Orange dashed = programmed heating curve (slope={slope}, shift={shift}). Gap between dots and curve indicates deviation from the set curve. <em>Scroll to zoom · Drag to pan · Double-click to reset.</em>',
    zoomReset:          '⟳ Reset zoom',
    scrollZoom:         'Scroll to zoom · Drag to pan · Double-click to reset.',

    // ── KPI label lookup (used by sc() in HTML template) ──────────────────
    kpiLabels: {
      'Cycles in period':        'CYCLES IN PERIOD',
      'Starts/hour':             'STARTS/HOUR',
      'Avg cycle duration':      'AVG CYCLE DURATION',
      'Burner runtime':          'BURNER RUNTIME',
      'Lifetime starts':         'LIFETIME STARTS',
      'Lifetime hours':          'LIFETIME HOURS',
      'Avg modulation (active)': 'AVG MODULATION (ACTIVE)',
      'Max modulation':          'MAX MODULATION',
      'Avg heat demand':         'AVG HEAT DEMAND',
      'Gas heating today':       'GAS HEATING TODAY',
      'Gas DHW today':           'GAS DHW TODAY',
      'Gas total today':         'GAS TOTAL TODAY',
      'Avg room temp':           'AVG ROOM TEMP',
      'Avg setpoint':            'AVG SETPOINT',
      'Max flow temp':           'MAX FLOW TEMP',
      'Condensing mode':         'CONDENSING MODE',
      'Avg flow temp':           'AVG FLOW TEMP',
      'Heat loss coeff.':        'HEAT LOSS COEFF.',
      'Est. peak load':          'EST. PEAK LOAD',
      'Boiler nominal':          'BOILER NOMINAL',
      'House efficiency':        'HOUSE EFFICIENCY',
      'Cycling score':           'CYCLING SCORE',
      'Comfort stability':       'COMFORT STABILITY',
      'Est. efficiency':         'EST. EFFICIENCY',
      'Heating curve':           'HEATING CURVE',
      'Avg temp':                'AVG TEMP',
      'Avg setpoint (DHW)':      'AVG SETPOINT',
    },

    // ── Insights — existing ─────────────────────────────────────────────
    insightNoIssues:    'No issues detected. System appears to be operating normally.',
    insightAddBoilerKW: 'Add --boilerKW <nominal_kW> to enable heat demand, peak load and house efficiency calculations (e.g. --boilerKW 19).',
    insightShortCycling: 'Short cycling detected — avg cycle {dur} min (ideal > 6 min). With {sph} starts/hour, the boiler is cycling too frequently. Check minimum modulation setting (technician), system hydraulic balance, and pump speed.',
    insightHighCycling: 'High cycling rate — {sph} starts/hour. Consider raising the heating curve setpoint or requesting minimum burner runtime calibration.',
    insightLowMod:      'Boiler running at low modulation (avg {mod}%) with short cycles. Consider lowering the heating curve to reduce cycling.',
    insightHighFlow:    'Flow temperature (avg {flow}°C) is higher than necessary for current outdoor conditions ({out}°C). Lowering the heating curve improves condensing efficiency.',
    insightOversized:   'Boiler nominal power ({kw} kW) is more than twice the estimated peak load (~{peak} kW). Oversizing is common for combi boilers but contributes to cycling.',
    insightGoodHouse:   'Building thermal efficiency rated {rating} (heat loss {coeff} kW/°C). Good insulation reduces heating demand.',
    insightCyclingSevere: 'Cycling severity score {score} — severe. Boiler starts {sph} times/hour with avg cycle {dur} min. Technician calibration of minimum modulation recommended.',
    insightCyclingHigh: 'Cycling severity score {score} — high. Boiler starts {sph} times/hour (avg cycle {dur} min). Consider requesting minimum modulation calibration.',
    insightMinMod:      'Boiler frequently operating near minimum modulation (avg {mod}%). Combined with short cycles, this suggests oversizing or flow temperature set too high.',
    insightFixedFlow:   'Flow temperature appears fixed (r={r}). Consider enabling weather compensation on your boiler controller to improve efficiency.',
    insightCurveMiscfg: 'Heating curve may be misconfigured — flow temperature correlates positively with outdoor temperature (r={r}). Expected: flow should rise when outdoor drops.',

    // ── Insights — NEW: recommendations with actions ────────────────────

    // ── Comfort efficiency strings ────────────────────────────────────────
    ceTitle:            '⚖️ Comfort vs Efficiency',
    ceNotEnoughData:    'Accumulating data — this analysis will be available after {need} days of monitoring ({have} of {need} collected so far).',
    ceStabilityLabel:   'Temperature stability',
    ceGasNormLabel:     'Normalised gas consumption',
    ceTrendStability:   'Comfort trend',
    ceTrendGas:         'Gas trend',
    ceInsightGasNoComfort: 'Gas consumption increased without comfort improvement — consider reviewing flow temperature or schedule.',
    ceInsightComfortFree:  'Comfort improved with no significant gas increase — system optimisation is working.',
    ceInsightBothWorse:    'Both comfort and efficiency worsened — configuration change or external factor detected.',
    ceInsightStable:       'No significant trend — system is stable.',
    ceImproved:         'improved',
    ceWorsened:         'worsened',
    ceUnchanged:        'stable',

    // ── Condensing score strings ──────────────────────────────────────────
    csTitle:            'Est. condensing score',
    csLabel:            'Return temp < 55°C',
    csNote:             'Estimated from flow temp and modulation (model-based, not measured).',
    csNotEnough:        'Insufficient burner data',

    // ── Heat loss line string ─────────────────────────────────────────────
    hlLineLabel:        'Theoretical heat loss (H={h} kW/°C)',


    // ── Additional untranslated strings ────────────────────────────────────
    heatingScheduleLabel:    'Heating schedule',
    leftAxisNote:            'Left axis: temperatures (°C) — Right axis: modulation, burner & outdoor humidity (% / 0–100)',
    cyclePerformanceTitle:   'Cycle performance (from API counters — precise)',
    modGasTitle:             'Modulation & gas (period)',
    todayScheduleKey:        "TODAY'S SCHEDULE",
    programDistKey:          'Program distribution',
    burnerBarsTitle:         'Cycle duration histogram (sampled)',
    heatmapTitle:            '🕐 Burner activity by hour of day',
    heatmapNote:             "Each cell = % of snapshots in that hour where burner was ON. Darker = more active. Hover for details.",
    heatmapLow:              'Low',
    heatmapHigh:             'High',
    heatmapBurnerPct:        'Burner ON %',
    gasChartTitle:           '📊 Daily gas consumption (m³)',
    gasChartNote:            "Stacked bars: heating (dark blue) + DHW (teal). Red line: daily total. Today's bar shows current accumulated value.",
    effChartTitle:           '📐 Daily thermal efficiency (heat produced / gas input)',
    effChartNote:            'Calculated from CSV columns: heat_heating_day_kwh ÷ (gas_heating_day_m3 × 10.55 kWh/m³). Condensing boilers can exceed 100%.',
    flowTempChartNote:       'Flow temperature (supply) — proxy for condensing efficiency. Below 55°C = condensing range.',
    energySummaryNote:       'Official aggregated data from Viessmann cloud API. Data snapshot: {ts}. Run viessmann-explore-history.js to refresh.',
    energySummaryStale:      'Data snapshot: {ts}.',
    gasSectionHeating:       'GAS CONSUMPTION (M³)',
    heatSectionTitle:        'HEAT PRODUCED (KWH)',
    thermalEffTitle:         'THERMAL EFFICIENCY (HEAT PRODUCED / GAS INPUT × PCS 10.55 KWH/M³)',
    thermalEffNote:          'Thermal efficiency >100% is possible for condensing boilers (latent heat recovery). Values >105% may indicate rounding in Viessmann API data.',
    forecastNote:            'Annual estimate requires at least {min} days of gas data (currently {n}). Run with --days {min} or more. Use --gasPriceEur to set your tariff.',
    forecastProjectionNote:  'Projection based on last {n} day(s) of data · gas price: €{price}/m³ · {trend}',
    forecastTrendRising:     '↑ Rising',
    forecastTrendFalling:    '↓ Falling',
    forecastTrendStable:     '→ Stable',
    deviceMessagesNote:      'Status, info and fault codes reported by the device. Translated from Viessmann service documentation.',
    deviceMessagesNoFile:    'No messages file found yet. Messages will appear here once the plugin writes the messages file.',
    annualEstLabel:          'ANNUAL ESTIMATE',
    avgConsPerDay:           'AVG CONSUMPTION/DAY',
    projNext30:              'PROJECTED NEXT 30 DAYS',
    needDays:                'Need {min} days (have {n})',
    heatingLastNDays:        'HEATING LAST {n} DAYS',
    heatingThisMonth:        'HEATING THIS MONTH',
    heatingThisYear:         'HEATING THIS YEAR',
    dhwThisMonth:            'DHW THIS MONTH',
    dhwThisYear:             'DHW THIS YEAR',
    totalThisMonth:          'TOTAL THIS MONTH',
    totalThisYear:           'TOTAL THIS YEAR',
    pumpPowerMonth:          'PUMP POWER MONTH',
    pumpPowerYear:           'PUMP POWER YEAR',
    effThisMonth:            'EFFICIENCY THIS MONTH',
    effThisYear:             'EFFICIENCY THIS YEAR',


    // ── Boiler section notes ─────────────────────────────────────────────
    cycleApiNoteShort:  '⚡ Cycle count uses <strong>API firmware counters</strong> (burner_starts delta) — captures all ignitions regardless of 15-min CSV sample rate. CSV edge detection would miss ~97% of cycles at this cycle frequency.',
    burnerBarNote:      '⚠️ Burner ON/OFF bars show only cycles visible within 15-min sampling interval. Actual cycle count ({n}) is {mult}× higher — see API counter KPIs above.',
    histogramNote:      'Distribution of burner ON durations visible in CSV samples. Actual cycle duration from API counters: avg {dur} min. Histogram shows only ~{vis} of {real} real cycles.',
    onlySamplesNote:    "Only {n} samples — data will accumulate over time (~1 every 15 min).",
    heatDemandSTitle:   'Heat Demand vs Outdoor Temperature',
    flowCurveSTitle:    '🌡️ Flow Temperature vs Outdoor — Actual vs Heating Curve',
    needDaysShort:      'Need {min} days (have {n})',


    // ── Badge labels ──────────────────────────────────────────────────────
    badgeLowDemand:     'Low demand',
    badgeNormal:        'Normal',
    badgeHigh:          'High',
    badgeSevere:        'Severe',
    badgeOK:            'OK',
    badgeShort:         'Short',
    badgeVeryShort:     'Very short',
    badgeCondensing:    'Condensing ✓',
    badgeBorderline:    'Borderline',
    badgeNotCond:       'Not condensing',
    badgeExcellent:     'Excellent',
    badgeOversized:     'Oversized',
    badgeLowMod:        'Low mod',
    badgeCheck:         'Check',


    heatDemandNote1:    'Each point = one burner-active sample. Red line = linear regression.',
    scrollZoomNote:     '<em>Scroll to zoom · Drag to pan · Double-click to reset.</em>',


    balancePoint:       'Balance point (estimated): {bp}°C outdoor.',
    hlLineLabelShort:   'Green line = theoretical heat loss curve (H={h} kW/°C).',


    condensingTimePct:  '{pct}% time',
    atOutdoorTemp:      'at {temp}°C outdoor',
    hoverDetails:       'Passa il cursore per dettagli.',
    noMessagesFile:     'No messages file found yet. Messages will appear here once the plugin writes',


    oneFilePerDevice:   '(one file per device per installation).',

    periodLabel:        'Period',
    generatedLabel:     'Generated',
    lastNDays:          'last {n} days',
    samplesLabel:       '{n} samples',
    progHeating:        'Heating',
    progReduced:        'Reduced',
    progNormal:         'Normal',
    progOff:            'Off',
    progComfort:        'Comfort',


    // ── Chart.js dataset labels ───────────────────────────────────────────
    chartRoomTemp:        'Room temp (°C)',
    chartHC0Setpoint:     'HC0 setpoint (°C)',
    chartFlowTemp:        'Flow temp (°C)',
    chartDHWTemp:         'DHW temp (°C)',
    chartDHWSetpoint:     'DHW setpoint (°C)',
    chartOutdoorTemp:     'Outdoor temp (°C)',
    chartOutdoorHum:      'Outdoor humidity (%)',
    chartModulation:      'Modulation (%)',
    chartBurnerBar:       'Burner (0/100)',
    chartBurnerOnOff:     'Burner (1=ON 0=OFF)',
    chartHeatDemand:      'Heat demand (kW)',
    chartTrend:           'Trend',
    chartHeatLossLine:    'Heat loss Q=H\u00d7\u0394T (H={h} kW/\u00b0C)',
    chartActualFlow:      'Actual flow temp (°C)',
    chartHeatingCurve:    'Heating curve (slope={slope}, shift={shift})',
    chartCondensingLimit: 'Condensing limit (55°C)',
    chartThermalEff:      'Thermal efficiency (%)',
    chartSetpoint:        'Setpoint (°C)',
    chartHeatingM3:       'Heating (m\u00b3)',
    chartDHWM3:           'DHW (m\u00b3)',
    chartTotalM3:         'Total (m\u00b3)',
    chartCycles:          'Cycles',
    chartPV:              '\u2600\ufe0f PV (W)',
    chartPVProd:          'PV production (W)',
    chartBattLevel:       'Battery level (%)',
    chartBattCharge:      '\uD83D\uDD0B Batt. charging (W)',
    chartBattChargeW:     'Charging (W)',
    chartBattDischarge:   'Discharging (W)',
    chartGridDraw:        '\uD83D\uDD0C Grid draw (W)',
    chartWallbox:         '\uD83D\uDE97 Wallbox (W)',
    chartWallboxW:        'Wallbox power (W)',


    // ── Program / schedule labels ─────────────────────────────────────────
    unstable:           'Unstable',
    progNormal:         'Normal',
    progComfort:        'Comfort',
    progReduced:        'Reduced',
    progOff:            'Off',
    progHeating:        'Heating',
    legendNormal:       'Normal',
    legendComfort:      'Comfort',
    legendReduced:      'Reduced',
    legendOff:          'Off',
    periodLabel:        'Period',
    generatedLabel:     'Generated',
    samplesLabel:       '{n} samples',
    lastNDays:          'last {n} days',


    // ── Axis labels & tooltip strings ────────────────────────────────────
    axisOutdoorTemp:    'Outdoor temperature (°C)',
    axisHeatDemand:     'Heat demand (kW)',
    axisFlowTemp:       'Flow temperature (°C)',
    axisAvgW:           'Avg W',
    tooltipOutdoor:     'outdoor: {x}°C  demand: {y} kW',
    tooltipFlowActual:  'outdoor: {x}°C  flow: {y}°C',
    tooltipFlowCurve:   'curve: {y}°C at {x}°C outdoor',


    axisCycles:         '# cycles',
    axisM3:             'm³',

    recTitle:           '💡 Recommended actions',
    recImpact:          'Estimated impact',
    recActionsLabel:    'Recommended actions',
    recOversizingActions: {
      title:   '⚠️ Boiler oversized ({ratio}×) — structural cycling',
      body:    'Minimum boiler power (~{minPow} kW) exceeds avg heat demand ({demand} kW). The boiler physically cannot modulate low enough — cycling is inevitable.',
      actions: [
        'Lower flow temperature setpoint → reduces heat demand per cycle',
        'Enable weather compensation (slope {slope}, shift {shift} → already set)',
        'Ask technician to calibrate minimum modulation to lowest possible value',
        'Consider hydraulic separator if not present',
      ],
      impact:  '−20–35% cycles · +2–4% efficiency',
    },
    recHighFlow: {
      title:   '⚠️ Flow temperature too high for outdoor conditions',
      body:    'Current avg flow {flow}°C with outdoor {out}°C. The heating curve prescribes {curve}°C — you are running {delta}°C above curve.',
      actions: [
        'Reduce curve shift by {suggestShift} points (from {shift} to {newShift})',
        'Or reduce slope slightly (from {slope} to {newSlope})',
        'Monitor room temperature over 2–3 days — reduce further if comfortable',
      ],
      impact:  '+3–5% condensing efficiency · −10–15% gas',
    },
    recNoWeatherComp: {
      title:   'ℹ️ Weather compensation not active',
      body:    'Flow temperature is fixed regardless of outdoor temperature (r={r}). In mild weather the boiler overheats — in cold weather it may underheat.',
      actions: [
        'Enable weather compensation on boiler controller (ViCare app → Heating → Curve)',
        'Recommended starting point: slope {slope}, shift {shift} (already programmed)',
        'Re-evaluate after 1 week of data',
      ],
      impact:  '−5–10% gas consumption · reduced cycling',
    },
  },

  it: {
    // ── Section titles ──────────────────────────────────────────────────
    reportTitle:        'Viessmann ViCare — Report Storico',
    sectionOverview:    '📈 Panoramica',
    sectionBoiler:      '🔥 Caldaia — Bruciatore',
    sectionHC0:         '🌡️ Circuito di Riscaldamento (HC0)',
    sectionSystemAnalysis: '🔍 Analisi Sistema',
    sectionDHW:         '🚿 Acqua Calda Sanitaria (ACS)',
    sectionEnergySummary: '📊 Riepilogo Energetico (da API Viessmann)',
    sectionEnergySystem: '⚡ Sistema Energetico (PV / Batteria / Rete)',
    sectionGasForecast: '⛽ Previsione Gas',
    sectionDeviceMessages: '🔔 Messaggi Dispositivo',

    // ── KPI labels ──────────────────────────────────────────────────────
    cyclesInPeriod:     'CICLI NEL PERIODO',
    startsPerHour:      'ACCENSIONI/ORA',
    avgCycleDuration:   'DURATA MEDIA CICLO',
    burnerRuntime:      'RUNTIME BRUCIATORE',
    lifetimeStarts:     'ACCENSIONI LIFETIME',
    lifetimeHours:      'ORE LIFETIME',
    avgModulation:      'MODULAZIONE MEDIA (ATTIVA)',
    maxModulation:      'MODULAZIONE MASSIMA',
    avgHeatDemand:      'DOMANDA TERMICA MEDIA',
    gasHeatingToday:    'GAS RISCALDAMENTO OGGI',
    gasDhwToday:        'GAS ACS OGGI',
    gasTotalToday:      'GAS TOTALE OGGI',
    avgRoomTemp:        'TEMP. MEDIA AMBIENTE',
    avgSetpoint:        'SETPOINT MEDIO',
    maxFlowTemp:        'TEMP. MANDATA MAX',
    condensingMode:     'MODALITÀ CONDENSAZIONE',
    avgFlowTemp:        'TEMP. MANDATA MEDIA',
    todaySchedule:      'PROGRAMMA ODIERNO',
    programDist:        'DISTRIBUZIONE PROGRAMMI',
    heatLossCoeff:      'COEFF. DISPERSIONE',
    estPeakLoad:        'CARICO DI PUNTA STIMATO',
    boilerNominal:      'POTENZA CALDAIA',
    houseEfficiency:    'EFFICIENZA EDIFICIO',
    cyclingScore:       'INDICE DI CICLAGGIO',
    comfortStability:   'STABILITÀ COMFORT',
    estEfficiency:      'EFFICIENZA STIMATA',
    heatingCurveLabel:  'CURVA DI RISCALDAMENTO',

    // ── Ratings ─────────────────────────────────────────────────────────
    condensing:         'Condensazione ✓',
    excellent:          'Eccellente',
    good:               'Buono',
    average:            'Medio',
    poor:               'Scarso',
    oversized:          'Sovradimensionata',
    weatherComp:        'Compensazione clima ✓',
    fixedFlow:          'Mandata fissa',
    checkCurve:         'Verificare curva',
    atOutdoor:          'a {temp}°C esterna',

    // ── Chart notes ─────────────────────────────────────────────────────
    cycleApiNote:       'Il conteggio cicli usa i <strong>contatori firmware API</strong> (delta burner_starts) — cattura tutte le accensioni indipendentemente dal campionamento CSV a 15 min. Il rilevamento da CSV mancherebbe il ~{pct}% dei cicli a questa frequenza.',
    burnerBarsNote:     'Le barre ON/OFF mostrano solo i cicli visibili nell\'intervallo di campionamento a 15 min. Il conteggio reale ({n}) è {mult}× superiore — vedi KPI contatori API sopra.',
    histNote:           'Distribuzione delle durate ON visibili nei campioni CSV. Durata media reale da API: {dur} min. L\'istogramma mostra solo ~{vis} dei {real} cicli reali.',
    flowTempNote:       'Temperatura di mandata (mandata) — indicatore dell\'efficienza di condensazione. Sotto 55°C = modalità condensazione.',
    heatDemandTitle:    'Domanda Termica vs Temperatura Esterna',
    heatDemandNote:     'Ogni punto = un campione con bruciatore attivo. Linea rossa = regressione lineare.{bp} <em>Scroll per zoom · Trascina per spostare · Doppio click per reset.</em>',
    balancePoint:       ' Balance point (stimato): {bp}°C esterna.',
    flowCurveTitle:     '🌡️ Temp. Mandata vs Esterna — Reale vs Curva',
    flowCurveNote:      'Punti blu = temperatura mandata misurata con bruciatore attivo. Linea arancione = curva programmata (pendenza={slope}, livello={shift}). Il gap indica la deviazione dalla curva impostata. <em>Scroll per zoom · Trascina per spostare · Doppio click per reset.</em>',
        zoomReset:          '⟳ Reimposta zoom', scrollZoom:         'Scroll per zoom · Trascina · Doppio click per reset.',

    // ── KPI label lookup ────────────────────────────────────────────────────
    kpiLabels: {
      'Cycles in period':        'CICLI NEL PERIODO',
      'Starts/hour':             'ACCENSIONI/ORA',
      'Avg cycle duration':      'DURATA MEDIA CICLO',
      'Burner runtime':          'RUNTIME BRUCIATORE',
      'Lifetime starts':         'ACCENSIONI LIFETIME',
      'Lifetime hours':          'ORE LIFETIME',
      'Avg modulation (active)': 'MODULAZIONE MEDIA (ATTIVA)',
      'Max modulation':          'MODULAZIONE MASSIMA',
      'Avg heat demand':         'DOMANDA TERMICA MEDIA',
      'Gas heating today':       'GAS RISCALDAMENTO OGGI',
      'Gas DHW today':           'GAS ACS OGGI',
      'Gas total today':         'GAS TOTALE OGGI',
      'Avg room temp':           'TEMP. MEDIA AMBIENTE',
      'Avg setpoint':            'SETPOINT MEDIO',
      'Max flow temp':           'TEMP. MANDATA MAX',
      'Condensing mode':         'MODALITÀ CONDENSAZIONE',
      'Avg flow temp':           'TEMP. MANDATA MEDIA',
      'Heat loss coeff.':        'COEFF. DISPERSIONE',
      'Est. peak load':          'CARICO DI PUNTA STIMATO',
      'Boiler nominal':          'POTENZA CALDAIA',
      'House efficiency':        'EFFICIENZA EDIFICIO',
      'Cycling score':           'INDICE DI CICLAGGIO',
      'Comfort stability':       'STABILITÀ COMFORT',
      'Est. efficiency':         'EFFICIENZA STIMATA',
      'Heating curve':           'CURVA DI RISCALDAMENTO',
      'Avg temp':                'TEMP. MEDIA',
      'Avg setpoint (DHW)':      'SETPOINT MEDIO',
    },

    // ── Insights — existing ─────────────────────────────────────────────
    insightNoIssues:    'Nessun problema rilevato. Il sistema sembra funzionare normalmente.',
    insightAddBoilerKW: 'Aggiungi --boilerKW <kW_nominali> per abilitare il calcolo della domanda termica, del carico di punta e dell\'efficienza edificio.',
    insightShortCycling: 'Ciclaggio breve rilevato — ciclo medio {dur} min (ideale > 6 min). Con {sph} accensioni/ora, la caldaia cicla troppo frequentemente. Verificare modulazione minima (tecnico), bilanciamento idraulico e velocità pompa.',
    insightHighCycling: 'Frequenza di ciclaggio elevata — {sph} accensioni/ora. Valutare di alzare il setpoint della curva o richiedere la calibrazione del runtime minimo del bruciatore.',
    insightLowMod:      'Caldaia che lavora a bassa modulazione (media {mod}%) con cicli brevi. Abbassare la curva di riscaldamento per ridurre il ciclaggio.',
    insightHighFlow:    'Temperatura di mandata (media {flow}°C) superiore al necessario per le condizioni esterne ({out}°C). Abbassare la curva migliora l\'efficienza di condensazione.',
    insightOversized:   'La potenza nominale della caldaia ({kw} kW) è più del doppio del carico di punta stimato (~{peak} kW). Il sovradimensionamento è comune nelle caldaie a condensazione ma contribuisce al ciclaggio.',
    insightGoodHouse:   'Efficienza termica edificio: {rating} (dispersione {coeff} kW/°C). Buona coibentazione riduce la domanda di calore.',
    insightCyclingSevere: 'Indice di ciclaggio {score} — grave. La caldaia si accende {sph} volte/ora con ciclo medio {dur} min. Calibrazione della modulazione minima da parte di un tecnico raccomandata.',
    insightCyclingHigh: 'Indice di ciclaggio {score} — alto. La caldaia si accende {sph} volte/ora (ciclo medio {dur} min). Valutare la calibrazione della modulazione minima.',
    insightMinMod:      'Caldaia spesso vicina alla modulazione minima (media {mod}%). Combinato con cicli brevi, indica sovradimensionamento o temperatura di mandata troppo alta.',
    insightFixedFlow:   'Temperatura di mandata apparentemente fissa (r={r}). Considerare l\'attivazione della compensazione climatica sul regolatore della caldaia.',
    insightCurveMiscfg: 'Curva di riscaldamento probabilmente non configurata correttamente — la temperatura di mandata correla positivamente con la temperatura esterna (r={r}). Atteso: la mandata dovrebbe salire quando la temperatura esterna scende.',

    // ── Insights — NEW: recommendations with actions ────────────────────

    // ── Comfort efficiency strings ────────────────────────────────────────
    ceTitle:            '⚖️ Comfort vs Efficienza',
    ceNotEnoughData:    "Dati in accumulo — questa analisi sarà disponibile dopo {need} giorni di monitoraggio ({have} di {need} raccolti finora).",
    ceStabilityLabel:   'Stabilità temperatura',
    ceGasNormLabel:     'Consumo gas normalizzato',
    ceTrendStability:   'Trend comfort',
    ceTrendGas:         'Trend gas',
    ceInsightGasNoComfort: "Il consumo di gas è aumentato senza miglioramenti al comfort — verificare la temperatura di mandata o il programma.",
    ceInsightComfortFree:  "Il comfort è migliorato senza aumento significativo del gas — l'ottimizzazione del sistema funziona.",
    ceInsightBothWorse:    "Sia il comfort che l'efficienza sono peggiorati — rilevato cambiamento di configurazione o fattore esterno.",
    ceInsightStable:       'Nessun trend significativo — il sistema è stabile.',
    ceImproved:         'migliorato',
    ceWorsened:         'peggiorato',
    ceUnchanged:        'stabile',

    // ── Condensing score strings ──────────────────────────────────────────
    csTitle:            'Indice condensazione stimato',
    csLabel:            'Temp. ritorno < 55°C',
    csNote:             "Stimato da temperatura mandata e modulazione (basato su modello, non misurato).",
    csNotEnough:        'Dati bruciatore insufficienti',

    // ── Heat loss line string ─────────────────────────────────────────────
    hlLineLabel:        'Dispersione termica teorica (H={h} kW/°C)',


    // ── Additional untranslated strings ────────────────────────────────────
    heatingScheduleLabel:    'Programma riscaldamento',
    leftAxisNote:            'Asse sinistro: temperature (°C) — Asse destro: modulazione, bruciatore e umidità esterna (% / 0–100)',
    cyclePerformanceTitle:   'Performance cicli (da contatori API — precisi)',
    modGasTitle:             'Modulazione e gas (periodo)',
    todayScheduleKey:        'PROGRAMMA ODIERNO',
    programDistKey:          'Distribuzione programmi',
    burnerBarsTitle:         'Istogramma durata cicli (campionato)',
    heatmapTitle:            '🕐 Attività bruciatore per ora del giorno',
    heatmapNote:             'Ogni cella = % di campioni in quell\'ora con bruciatore ON. Più scuro = più attivo. Passa il cursore per dettagli.',
    heatmapLow:              'Basso',
    heatmapHigh:             'Alto',
    heatmapBurnerPct:        'Bruciatore ON %',
    gasChartTitle:           '📊 Consumo gas giornaliero (m³)',
    gasChartNote:            'Barre: riscaldamento (blu scuro) + ACS (turchese). Linea rossa: totale giornaliero. La barra di oggi mostra il valore accumulato.',
    effChartTitle:           '📐 Efficienza termica giornaliera (calore prodotto / gas consumato)',
    effChartNote:            'Calcolato dalle colonne CSV: heat_heating_day_kwh ÷ (gas_heating_day_m3 × 10.55 kWh/m³). Le caldaie a condensazione possono superare il 100%.',
    flowTempChartNote:       'Temperatura di mandata — indicatore dell\'efficienza di condensazione. Sotto 55°C = modalità condensazione.',
    energySummaryNote:       'Dati aggregati ufficiali dall\'API cloud Viessmann. Snapshot: {ts}. Esegui viessmann-explore-history.js per aggiornare.',
    energySummaryStale:      'Snapshot: {ts}.',
    gasSectionHeating:       'CONSUMO GAS (M³)',
    heatSectionTitle:        'CALORE PRODOTTO (KWH)',
    thermalEffTitle:         'EFFICIENZA TERMICA (CALORE PRODOTTO / GAS × PCS 10.55 KWH/M³)',
    thermalEffNote:          'Efficienza >100% possibile nelle caldaie a condensazione (recupero calore latente). Valori >105% possono indicare arrotondamenti nei dati API Viessmann.',
    forecastNote:            'La stima annuale richiede almeno {min} giorni di dati gas (attualmente {n}). Usa --days {min} o più. Usa --gasPriceEur per impostare la tariffa.',
    forecastProjectionNote:  'Proiezione basata sugli ultimi {n} giorni · prezzo gas: €{price}/m³ · {trend}',
    forecastTrendRising:     '↑ In aumento',
    forecastTrendFalling:    '↓ In calo',
    forecastTrendStable:     '→ Stabile',
    deviceMessagesNote:      'Codici di stato, info e guasto riportati dal dispositivo. Tradotti dalla documentazione di servizio Viessmann.',
    deviceMessagesNoFile:    'Nessun file messaggi trovato. I messaggi appariranno qui una volta che il plugin ha scritto il file.',
    annualEstLabel:          'STIMA ANNUALE',
    avgConsPerDay:           'CONSUMO MEDIO/GIORNO',
    projNext30:              'PROIEZIONE 30 GIORNI',
    needDays:                'Necessari {min} giorni (disponibili {n})',
    heatingLastNDays:        'RISCALDAMENTO ULTIMI {n} GIORNI',
    heatingThisMonth:        'RISCALDAMENTO QUESTO MESE',
    heatingThisYear:         'RISCALDAMENTO QUEST\'ANNO',
    dhwThisMonth:            'ACS QUESTO MESE',
    dhwThisYear:             'ACS QUEST\'ANNO',
    totalThisMonth:          'TOTALE QUESTO MESE',
    totalThisYear:           'TOTALE QUEST\'ANNO',
    pumpPowerMonth:          'POMPA QUESTO MESE',
    pumpPowerYear:           'POMPA QUEST\'ANNO',
    effThisMonth:            'EFFICIENZA QUESTO MESE',
    effThisYear:             'EFFICIENZA QUEST\'ANNO',


    // ── Boiler section notes ─────────────────────────────────────────────
    cycleApiNoteShort:  '⚡ Il conteggio cicli usa i <strong>contatori firmware API</strong> (delta burner_starts) — cattura tutte le accensioni indipendentemente dal campionamento CSV a 15 min. Il rilevamento da CSV mancherebbe il ~97% dei cicli.',
    burnerBarNote:      '⚠️ Le barre ON/OFF mostrano solo i cicli visibili nell\'intervallo a 15 min. Il conteggio reale ({n}) è {mult}× superiore — vedi KPI sopra.',
    histogramNote:      'Distribuzione durate ON visibili nei campioni CSV. Durata media reale da API: {dur} min. Istogramma: ~{vis} dei {real} cicli reali.',
    onlySamplesNote:    'Solo {n} campioni — i dati si accumuleranno nel tempo (~1 ogni 15 min).',
    heatDemandSTitle:   'Domanda Termica vs Temperatura Esterna',
    flowCurveSTitle:    '🌡️ Temp. Mandata vs Esterna — Reale vs Curva',
    needDaysShort:      'Necessari {min} giorni (disponibili {n})',


    // ── Badge labels ──────────────────────────────────────────────────────
    badgeLowDemand:     'Bassa richiesta',
    badgeNormal:        'Normale',
    badgeHigh:          'Alto',
    badgeSevere:        'Grave',
    badgeOK:            'OK',
    badgeShort:         'Corto',
    badgeVeryShort:     'Molto corto',
    badgeCondensing:    'Condensazione ✓',
    badgeBorderline:    'Limite',
    badgeNotCond:       'Non condensante',
    badgeExcellent:     'Eccellente',
    badgeOversized:     'Sovradimensionata',
    badgeLowMod:        'Bassa mod.',
    badgeCheck:         'Verificare',


    heatDemandNote1:    'Ogni punto = campione con bruciatore attivo. Linea rossa = regressione lineare.',
    scrollZoomNote:     '<em>Scroll per zoom · Trascina · Doppio click per reset.</em>',


    balancePoint:       'Punto di bilanciamento (stimato): {bp}°C esterna.',
    hlLineLabelShort:   'Linea verde = curva di dispersione termica teorica (H={h} kW/°C).',


    condensingTimePct:  '{pct}% del tempo',
    atOutdoorTemp:      'a {temp}°C esterna',
    hoverDetails:       'Passa il cursore per dettagli.',
    noMessagesFile:     'File messaggi non ancora creato. I messaggi appariranno qui una volta che il plugin scriverà il file',


    oneFilePerDevice:   '(un file per dispositivo per installazione).',

    periodLabel:        'Periodo',
    generatedLabel:     'Generato',
    lastNDays:          'ultimi {n} giorni',
    samplesLabel:       '{n} campioni',
    progHeating:        'Riscaldamento',
    progReduced:        'Ridotto',
    progNormal:         'Normale',
    progOff:            'Off',
    progComfort:        'Comfort',


    // ── Chart.js dataset labels ───────────────────────────────────────────
    chartRoomTemp:        'Temp. ambiente (°C)',
    chartHC0Setpoint:     'Setpoint HC0 (°C)',
    chartFlowTemp:        'Temp. mandata (°C)',
    chartDHWTemp:         'Temp. ACS (°C)',
    chartDHWSetpoint:     'Setpoint ACS (°C)',
    chartOutdoorTemp:     'Temp. esterna (°C)',
    chartOutdoorHum:      'Umidità esterna (%)',
    chartModulation:      'Modulazione (%)',
    chartBurnerBar:       'Bruciatore (0/100)',
    chartBurnerOnOff:     'Bruciatore (1=ON 0=OFF)',
    chartHeatDemand:      'Domanda termica (kW)',
    chartTrend:           'Tendenza',
    chartHeatLossLine:    'Dispersione termica Q=H\u00d7\u0394T (H={h} kW/\u00b0C)',
    chartActualFlow:      'Temp. mandata reale (°C)',
    chartHeatingCurve:    'Curva riscaldamento (pendenza={slope}, livello={shift})',
    chartCondensingLimit: 'Limite condensazione (55°C)',
    chartThermalEff:      'Efficienza termica (%)',
    chartSetpoint:        'Setpoint (°C)',
    chartHeatingM3:       'Riscaldamento (m\u00b3)',
    chartDHWM3:           'ACS (m\u00b3)',
    chartTotalM3:         'Totale (m\u00b3)',
    chartCycles:          'Cicli',
    chartPV:              '\u2600\ufe0f FV (W)',
    chartPVProd:          'Produzione FV (W)',
    chartBattLevel:       'Livello batteria (%)',
    chartBattCharge:      '\uD83D\uDD0B Carica batt. (W)',
    chartBattChargeW:     'Carica (W)',
    chartBattDischarge:   'Scarica (W)',
    chartGridDraw:        '\uD83D\uDD0C Prelievo rete (W)',
    chartWallbox:         '\uD83D\uDE97 Wallbox (W)',
    chartWallboxW:        'Potenza Wallbox (W)',


    // ── Program / schedule labels ─────────────────────────────────────────
    unstable:           'Instabile',
    progNormal:         'Normale',
    progComfort:        'Comfort',
    progReduced:        'Ridotto',
    progOff:            'Spento',
    progHeating:        'Riscaldamento',
    legendNormal:       'Normale',
    legendComfort:      'Comfort',
    legendReduced:      'Ridotto',
    legendOff:          'Spento',
    periodLabel:        'Periodo',
    generatedLabel:     'Generato',
    samplesLabel:       '{n} campioni',
    lastNDays:          'ultimi {n} giorni',


    // ── Axis labels & tooltip strings ────────────────────────────────────
    axisOutdoorTemp:    'Temperatura esterna (°C)',
    axisHeatDemand:     'Domanda termica (kW)',
    axisFlowTemp:       'Temperatura mandata (°C)',
    axisAvgW:           'Media W',
    tooltipOutdoor:     'esterna: {x}°C  domanda: {y} kW',
    tooltipFlowActual:  'esterna: {x}°C  mandata: {y}°C',
    tooltipFlowCurve:   'curva: {y}°C a {x}°C esterna',


    axisCycles:         '# cicli',
    axisM3:             'm³',

    recTitle:           '💡 Azioni consigliate',
    recImpact:          'Impatto stimato',
    recActionsLabel:    'Azioni consigliate',
    recOversizingActions: {
      title:   '⚠️ Caldaia sovradimensionata ({ratio}×) — ciclaggio strutturale',
      body:    'La potenza minima della caldaia (~{minPow} kW) supera la domanda termica media ({demand} kW). La caldaia non riesce fisicamente a modulare abbastanza in basso — il ciclaggio è inevitabile.',
      actions: [
        'Abbassare il setpoint della temperatura di mandata → riduce la domanda termica per ciclo',
        'Attivare la compensazione climatica (pendenza {slope}, livello {shift} → già impostati)',
        'Chiedere al tecnico di calibrare la modulazione minima al valore più basso possibile',
        'Verificare la presenza di un separatore idraulico',
      ],
      impact:  '−20–35% cicli · +2–4% efficienza',
    },
    recHighFlow: {
      title:   '⚠️ Temperatura di mandata troppo alta per le condizioni esterne',
      body:    'Mandata media {flow}°C con esterno a {out}°C. La curva prescrive {curve}°C — stai lavorando {delta}°C sopra la curva.',
      actions: [
        'Ridurre il livello della curva di {suggestShift} punti (da {shift} a {newShift})',
        'Oppure ridurre leggermente la pendenza (da {slope} a {newSlope})',
        'Monitorare la temperatura ambiente per 2–3 giorni e ridurre ulteriormente se il comfort lo permette',
      ],
      impact:  '+3–5% efficienza condensazione · −10–15% gas',
    },
    recNoWeatherComp: {
      title:   'ℹ️ Compensazione climatica non attiva',
      body:    'La temperatura di mandata è fissa indipendentemente dalla temperatura esterna (r={r}). Nelle giornate miti la caldaia surriscalda, in quelle fredde potrebbe non bastare.',
      actions: [
        'Attivare la compensazione climatica sul regolatore (app ViCare → Riscaldamento → Curva)',
        'Punto di partenza consigliato: pendenza {slope}, livello {shift} (già programmati)',
        'Rivalutare dopo 1 settimana di dati',
      ],
      impact:  '−5–10% consumo gas · riduzione ciclaggio',
    },
  },
};

// Helper: get string with variable substitution
// Usage: T('insightOversized', {kw:25, peak:9.9})
function T(key, vars) {
  const lang = STRINGS[LANG] || STRINGS['en'];
  let s = lang[key] ?? STRINGS['en'][key] ?? key;
  if (vars && typeof s === 'string') {
    Object.entries(vars).forEach(([k,v]) => { s = s.replaceAll('{'+k+'}', v); });
  }
  return s;
}

// Helper for nested objects (recommendations)
function TR(key) {
  const lang = STRINGS[LANG] || STRINGS['en'];
  return lang[key] ?? STRINGS['en'][key] ?? {};
}


const HB_PATH = getArg('--path', '/var/lib/homebridge');
const INSTALLATION_ID = getArg('--installation', '');
const csvSuffix = INSTALLATION_ID ? `-${INSTALLATION_ID}` : '';
const CSV_FILE = path.join(HB_PATH, `viessmann-history${csvSuffix}.csv`);
const SCHED_FILE_PATH = INSTALLATION_ID
  ? path.join(HB_PATH, `viessmann-schedule-${INSTALLATION_ID}.json`)
  : path.join(HB_PATH, 'viessmann-schedule.json');
const today = new Date().toISOString().slice(0, 10);
const outSuffix = INSTALLATION_ID ? `-${INSTALLATION_ID}` : '';
const OUT_FILE = getArg('--out', path.join(HB_PATH, `viessmann-report${outSuffix}-${today}.html`));

if (!fs.existsSync(CSV_FILE)) {
  const hint = INSTALLATION_ID ? '' : '\nTip: use --installation <ID> to specify an installation (e.g. --installation 2045571)';
  console.error(`ERROR: CSV not found: ${CSV_FILE}${hint}\nStart Homebridge with the plugin to begin collecting data.`);
  process.exit(1);
}

const lines = fs.readFileSync(CSV_FILE, 'utf8').trim().split('\n');
const headers = lines[0].split(',').map(h => h.trim());
const rows = lines.slice(1).map(line => {
  const vals = line.split(',');
  const obj = {};
  headers.forEach((h, i) => { obj[h] = vals[i]?.trim() || ''; });
  return obj;
});

const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - DAYS);
const filtered = rows.filter(r => r.timestamp && new Date(r.timestamp) >= cutoff);
if (!filtered.length) { console.error(`ERROR: No data in the last ${DAYS} days.`); process.exit(1); }

console.log(`Generating HTML report for last ${DAYS} days (${filtered.length} data points)...`);

const toNum = v => parseFloat(v) || 0;
const avg = (arr, key) => { const v = arr.map(r => toNum(r[key])).filter(x => x > 0); return v.length ? (v.reduce((a,b)=>a+b,0)/v.length).toFixed(1) : null; };
const maxVal = (arr, key) => { const v = arr.map(r => toNum(r[key])).filter(x => x > 0); return v.length ? Math.max(...v).toFixed(1) : null; };

const boilerRows = filtered.filter(r => r.accessory === 'boiler');
const hcRows     = filtered.filter(r => r.accessory === 'hc0');
const dhwRows    = filtered.filter(r => r.accessory === 'dhw');
const energyRows = filtered.filter(r => r.accessory === 'energy');

const burnerOnPct   = boilerRows.length ? ((boilerRows.filter(r => r.burner_active==='true').length/boilerRows.length)*100).toFixed(0) : null;
const avgMod        = avg(boilerRows, 'modulation');
const maxMod        = maxVal(boilerRows, 'modulation');
const avgRoom       = avg(hcRows, 'room_temp');
const avgTarget     = avg(hcRows, 'target_temp');
const avgDhw        = avg(dhwRows, 'dhw_temp');
const avgDhwTarget  = avg(dhwRows, 'dhw_target');

// Energy stats
const hasPV      = energyRows.some(r => r.pv_production_w !== '');
const hasBattery = energyRows.some(r => r.battery_level !== '');
const hasWallbox = energyRows.some(r => r.wallbox_charging !== '');
const avgPV      = avg(energyRows, 'pv_production_w');
const maxPV      = maxVal(energyRows, 'pv_production_w');
const latestEnergy = energyRows[energyRows.length-1] || {};
const lastPvDaily   = latestEnergy.pv_daily_kwh   || null;
const lastBattLevel = latestEnergy.battery_level  || null;
const avgWallboxPwr = avg(energyRows.filter(r => r.wallbox_charging==='true'), 'wallbox_power_w');

const lb = boilerRows[boilerRows.length-1] || {};
const burnerStarts  = lb.burner_starts || null;
const burnerHours   = lb.burner_hours  || null;

// Use DELTA of burner_starts/hours within the report period — not the lifetime ratio.
// The CSV has a column mapping issue in early rows (starts=hours value) and the
// 15-min sample rate misses ~97% of real cycles. API counter delta is the only
// reliable source.
// Guard: only rows that have BOTH columns (plugin >= v2.0.40).
const validBurnerRows = boilerRows.filter(r => r.burner_starts && r.burner_hours && parseFloat(r.burner_hours) > 0);
const firstVBR = validBurnerRows[0]   || null;
const lastVBR  = validBurnerRows[validBurnerRows.length-1] || null;
const deltaStarts = (firstVBR && lastVBR) ? Math.max(0, parseInt(lastVBR.burner_starts) - parseInt(firstVBR.burner_starts)) : null;
const deltaHours  = (firstVBR && lastVBR) ? Math.max(0, parseFloat(lastVBR.burner_hours)  - parseFloat(firstVBR.burner_hours))  : null;

// Starts per wall-clock hour (NOT per runtime hour):
//   sph = deltaStarts / period_hours  →  e.g. 353 starts / 130h = 2.7/h
//   NOT deltaStarts / deltaHours (353/36 = 9.8 would mean starts per burner-running hour)
// Avg cycle duration = deltaHours(runtime) * 60 / deltaStarts  →  6.1 min
// Runtime % = deltaHours / period_hours * 100  →  28%
const periodHours = (firstVBR && lastVBR)
  ? Math.max(1, (new Date(lastVBR.timestamp) - new Date(firstVBR.timestamp)) / 3600000)
  : null;
const sph = (deltaStarts !== null && periodHours !== null && periodHours > 0)
  ? (deltaStarts / periodHours).toFixed(1)
  : null;
const avgCycleDurReal = (deltaStarts !== null && deltaHours !== null && deltaStarts > 0)
  ? (deltaHours * 60 / deltaStarts).toFixed(1)
  : null;
const burnerRuntimePct = (deltaHours !== null && periodHours !== null && periodHours > 0)
  ? (deltaHours / periodHours * 100).toFixed(0)
  : null;
const realCycleCount = deltaStarts;
const realAvgDur     = avgCycleDurReal;

// Thresholds for wall-clock starts/hour:
//   < 2/h = normal (long cycles, low demand)
//   2–4/h = acceptable
//   > 4/h = high cycling concern
const effCls   = sph ? (parseFloat(sph) < 2 ? 'good' : parseFloat(sph) < 4 ? 'warn' : 'bad') : 'neutral';
const effLabel = sph ? (parseFloat(sph) < 2 ? T('badgeNormal') : parseFloat(sph) < 4 ? T('badgeHigh') : T('badgeSevere')) : 'N/A';

// --- Flow temperature stats (from hc0 rows) ---
const avgFlow  = avg(hcRows, 'flow_temp');
const maxFlow  = maxVal(hcRows, 'flow_temp');
// Condensing efficiency: flow < 55°C means returning in condensing range (proxy, no return sensor)
const flowVals = hcRows.map(r => parseFloat(r.flow_temp)).filter(v => !isNaN(v) && v > 0);
const condensingPct = flowVals.length ? ((flowVals.filter(v => v < 55).length / flowVals.length) * 100).toFixed(0) : null;
const condensingCls = condensingPct !== null ? (parseFloat(condensingPct) >= 80 ? 'good' : parseFloat(condensingPct) >= 40 ? 'warn' : 'neutral') : 'neutral';
const condensingLabel = condensingPct !== null ? (parseFloat(condensingPct) >= 80 ? T('badgeCondensing') : parseFloat(condensingPct) >= 40 ? T('badgeBorderline') : T('badgeNotCond')) : 'N/A';

// --- Gas consumption (real data from API, m³/day) ---
const hasGasData = boilerRows.some(r => r.gas_heating_day_m3 !== '' && r.gas_heating_day_m3 !== undefined);
const latestGasRow = [...boilerRows].reverse().find(r => r.gas_heating_day_m3 !== '' && r.gas_heating_day_m3 !== undefined) || {};
const gasHeatingToday  = latestGasRow.gas_heating_day_m3  || null;
const gasDhwToday      = latestGasRow.gas_dhw_day_m3      || null;
const gasTotalToday    = (gasHeatingToday && gasDhwToday) ? (parseFloat(gasHeatingToday) + parseFloat(gasDhwToday)).toFixed(2) : gasHeatingToday || null;

// --- Daily gas aggregation (max per calendar day = total consumption for that day) ---
const gasPerDay = {};
boilerRows.forEach(r => {
  if (!r.gas_heating_day_m3 && !r.gas_dhw_day_m3) return;
  const day = r.timestamp.slice(0, 10);
  if (!gasPerDay[day]) gasPerDay[day] = { heating: 0, dhw: 0 };
  gasPerDay[day].heating = Math.max(gasPerDay[day].heating, parseFloat(r.gas_heating_day_m3) || 0);
  gasPerDay[day].dhw     = Math.max(gasPerDay[day].dhw,     parseFloat(r.gas_dhw_day_m3)     || 0);
});
const gasDays         = Object.keys(gasPerDay).sort();
const gasBarLabels    = gasDays.map(d => { const [y,m,dd]=d.split('-'); return `${dd}/${m}`; });
const gasBarHeating   = gasDays.map(d => +gasPerDay[d].heating.toFixed(2));
const gasBarDhw       = gasDays.map(d => +gasPerDay[d].dhw.toFixed(2));
const gasLineTotal    = gasDays.map(d => +(gasPerDay[d].heating + gasPerDay[d].dhw).toFixed(2));
const hasGasChart     = gasDays.length >= 1;

// --- API Summary data (from viessmann-history-explore-*.json if present) ---
let apiSummary = null;
try {
  const exploreFile = require('path').join(HB_PATH, `viessmann-history-explore-${INSTALLATION_ID || 'all'}.json`);
  if (require('fs').existsSync(exploreFile)) {
    const raw = JSON.parse(require('fs').readFileSync(exploreFile, 'utf8'));
    // Find device with heating features (device id = '0' usually)
    const devKey = Object.keys(raw.devices || {}).find(k => {
      const d = raw.devices[k];
      return d.historyFeatures && d.historyFeatures.some(f => f.feature.includes('gas.consumption'));
    });
    if (devKey) {
      const dev = raw.devices[devKey];
      const feat = (name) => dev.historyFeatures.find(f => f.feature === name);
      const val  = (name, prop) => { const f = feat(name); return f?.samples?.[prop]?.value ?? null; };
      const unit = (name, prop) => { const f = feat(name); return f?.samples?.[prop]?.unit ?? ''; };
      apiSummary = {
        timestamp:        raw.timestamp,
        gasHeatMonth:     val('heating.gas.consumption.summary.heating', 'currentMonth'),
        gasHeatYear:      val('heating.gas.consumption.summary.heating', 'currentYear'),
        gasHeat7d:        val('heating.gas.consumption.summary.heating', 'lastSevenDays'),
        gasDhwMonth:      val('heating.gas.consumption.summary.dhw',     'currentMonth'),
        gasDhwYear:       val('heating.gas.consumption.summary.dhw',     'currentYear'),
        heatProdHeatMonth:val('heating.heat.production.summary.heating', 'currentMonth'),
        heatProdHeatYear: val('heating.heat.production.summary.heating', 'currentYear'),
        heatProdDhwMonth: val('heating.heat.production.summary.dhw',     'currentMonth'),
        heatProdDhwYear:  val('heating.heat.production.summary.dhw',     'currentYear'),
        pwrConsHeatMonth: val('heating.power.consumption.summary.heating','currentMonth'),
        pwrConsHeatYear:  val('heating.power.consumption.summary.heating','currentYear'),
        burnerLifeStarts: val('heating.burners.0.statistics', 'starts'),
        burnerLifeHours:  val('heating.burners.0.statistics', 'hours'),
      };
      // Thermal efficiency = heat produced / (gas consumed × PCS)
      const GAS_PCS_EFF = 10.55;
      if (apiSummary.heatProdHeatYear && apiSummary.gasHeatYear && apiSummary.gasHeatYear > 0) {
        apiSummary.thermalEffYear = Math.min(110, Math.round(
          (apiSummary.heatProdHeatYear / (apiSummary.gasHeatYear * GAS_PCS_EFF)) * 100
        ));
      }
      if (apiSummary.heatProdHeatMonth && apiSummary.gasHeatMonth && apiSummary.gasHeatMonth > 0) {
        apiSummary.thermalEffMonth = Math.min(110, Math.round(
          (apiSummary.heatProdHeatMonth / (apiSummary.gasHeatMonth * GAS_PCS_EFF)) * 100
        ));
      }
    }
  }
} catch(e) { /* explore file not present — skip */ }

// --- Heating schedule ---
const SCHED_FILE = SCHED_FILE_PATH;
let heatingSchedule = null;
try {
  if (fs.existsSync(SCHED_FILE)) {
    heatingSchedule = JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8'));
  }
} catch(_) {}

// Given a Date, return expected program from schedule ('normal'|'reduced'|'comfort'|null)
function expectedProgram(dt) {
  if (!heatingSchedule?.entries) return null;
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = days[dt.getDay()];
  const slots = heatingSchedule.entries[dayKey] || [];
  const hhmm = dt.getHours() * 60 + dt.getMinutes();
  for (const s of slots) {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    if (hhmm >= sh * 60 + sm && hhmm < eh * 60 + em) return s.mode;
  }
  return 'reduced';
}

// Build today's schedule slots as human-readable string
function todayScheduleText() {
  if (!heatingSchedule?.entries) return null;
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = days[new Date().getDay()];
  const slots = heatingSchedule.entries[dayKey] || [];
  if (!slots.length) return 'reduced (all day)';
  const parts = slots.map(s => `${s.start}–${s.end} ${s.mode}`);
  return parts.join(', ') + ' · rest: reduced';
}

// Build background annotation bands for overview chart (one band per normal slot today)
function schedBands() {
  if (!heatingSchedule?.entries) return [];
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const bands = [];
  // For each day in the report period build bands
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayKey = days[d.getDay()];
    const dateStr = d.toISOString().slice(0,10);
    const slots = heatingSchedule.entries[dayKey] || [];
    for (const s of slots) {
      bands.push({ date: dateStr, start: s.start, end: s.end, mode: s.mode });
    }
  }
  return bands;
}

const scheduleToday = todayScheduleText();
const schedBandData = schedBands();

// --- Schedule bar HTML (pre-computed server-side, injected as static HTML) ---
function buildScheduleBarHtml() {
  if (!heatingSchedule?.entries) return '';
  const COLORS = { normal:'#4caf50', comfort:'#ff9800', reduced:'#90a4ae', off:'#ef5350' };
  const DAYS = ['sun','mon','tue','wed','thu','fri','sat'];
  const entries = heatingSchedule.entries;
  const totalMins = 24 * 60;

  // Get unique days present in the report (from ovLabels)
  const daySet = [...new Set(ovLabels.map(l => {
    const dp = l.split(' ')[0].split('/'); // [dd, MM]
    return dp[1] + '-' + dp[0]; // YYYY-MM format compatible
  }))];

  let segments = [];
  for (const ds of daySet) {
    const [mo, dd] = ds.split('-');
    const dt = new Date(new Date().getFullYear(), parseInt(mo)-1, parseInt(dd));
    const dayKey = DAYS[dt.getDay()];
    const slots = [...(entries[dayKey] || [])].sort((a, b) => {
      const am = parseInt(a.start)*60 + parseInt(a.start.split(':')[1]);
      const bm = parseInt(b.start)*60 + parseInt(b.start.split(':')[1]);
      return am - bm;
    });
    let prev = 0;
    for (const s of slots) {
      const sm = parseInt(s.start.split(':')[0])*60 + parseInt(s.start.split(':')[1]);
      const em = parseInt(s.end.split(':')[0])*60   + parseInt(s.end.split(':')[1]);
      if (sm > prev) segments.push({ mode:'reduced', mins: sm - prev });
      segments.push({ mode: s.mode, mins: em - sm });
      prev = em;
    }
    if (prev < totalMins) segments.push({ mode:'reduced', mins: totalMins - prev });
  }

  const totalSegMins = segments.reduce((a, b) => a + b.mins, 0);
  const bars = segments.map(s => {
    const pct = (s.mins / totalSegMins * 100).toFixed(3);
    const color = COLORS[s.mode] || COLORS.reduced;
    const modeKey = 'prog'+s.mode.charAt(0).toUpperCase()+s.mode.slice(1); const label = T(modeKey) || s.mode.charAt(0).toUpperCase()+s.mode.slice(1);
    const hrs = Math.round(s.mins / 60 * 10) / 10;
    return `<div title="${label} (${hrs}h)" style="width:${pct}%;background:${color};height:100%"></div>`;
  }).join('');

  const legend = Object.entries(COLORS).map(([mode, color]) =>
    `<span style="font-size:10px;color:#888"><span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:2px;margin-right:3px;vertical-align:middle"></span>${T('legend'+mode.charAt(0).toUpperCase()+mode.slice(1)) || mode.charAt(0).toUpperCase()+mode.slice(1)}</span>`
  ).join('<span style="margin:0 8px"></span>');

  return `<div style="margin-top:6px">
    <div style="font-size:11px;color:#888;margin-bottom:3px">${T('heatingScheduleLabel')}</div>
    <div style="display:flex;height:14px;border-radius:4px;overflow:hidden;width:100%">${bars}</div>
    <div style="display:flex;gap:12px;margin-top:4px;flex-wrap:wrap">${legend}</div>
  </div>`;
}

// --- Heat demand: avg modulation × nominal power ---
const NOMINAL_KW = typeof process.env.NOMINAL_KW !== 'undefined' ? parseFloat(process.env.NOMINAL_KW) : 24;
const activeBurnerRows = boilerRows.filter(r => r.burner_active === 'true' && toNum(r.modulation) > 0);
const avgHeatDemand = activeBurnerRows.length
  ? ((activeBurnerRows.reduce((s,r) => s + toNum(r.modulation), 0) / activeBurnerRows.length / 100) * NOMINAL_KW).toFixed(1)
  : null;

// --- Burner cycle analysis ---
// PRIMARY source: API counter delta (burner_starts / burner_hours) — captures ALL ignitions.
// CSV edge detection misses ~97% of cycles because refresh is 15 min but cycles avg 6 min.
// We keep edge detection only for the histogram (visual distribution of detected cycles).
const sortedBoiler = [...boilerRows].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
const cycles = [];
let cycleStart = null;
for (let i = 0; i < sortedBoiler.length; i++) {
  const on = sortedBoiler[i].burner_active === 'true';
  if (on && cycleStart === null) cycleStart = new Date(sortedBoiler[i].timestamp);
  if (!on && cycleStart !== null) {
    const durationMin = (new Date(sortedBoiler[i].timestamp) - cycleStart) / 60000;
    if (durationMin >= 1) cycles.push(durationMin);
    cycleStart = null;
  }
}
// cycleCount from CSV edges (used only for histogram — severely underestimates real count)
const cycleCount      = cycles.length;
const avgCycleDur     = cycleCount ? (cycles.reduce((a,b)=>a+b,0)/cycleCount).toFixed(0) : null;
const shortestCycle   = cycleCount ? Math.min(...cycles).toFixed(0) : null;
const shortCycleCls   = shortestCycle ? (parseFloat(shortestCycle) < 5 ? 'warn' : 'good') : 'neutral';

// realCycleCount, realAvgDur, sph already defined above from delta calculation

// ─────────────────────────────────────────────────────────────────────────────
// HEATING SYSTEM ASSISTANT
// boilerNominalPowerKW: CLI param > env var > default 0 (kW-based cards hidden)
// designOutdoorTemp:    CLI param > env var > default -7°C (Europe central)
// ─────────────────────────────────────────────────────────────────────────────
const BOILER_KW   = parseFloat(getArg('--boilerKW',   process.env.BOILER_KW   || '0'));
const DESIGN_TEMP = parseFloat(getArg('--designTemp', process.env.DESIGN_TEMP || '-7'));
// Heating curve: CLI overrides > explore JSON > 0 (disabled)
const _curveCli_slope = parseFloat(getArg('--curveSlope', process.env.CURVE_SLOPE || '0'));
const _curveCli_shift = getArg('--curveShift', process.env.CURVE_SHIFT || '');
const _curveFromExplore = (() => {
  try {
    const _ePath = require('path').join(HB_PATH, `viessmann-history-explore-${INSTALLATION_ID || 'all'}.json`);
    if (!require('fs').existsSync(_ePath)) return null;
    const _raw = JSON.parse(require('fs').readFileSync(_ePath, 'utf8'));
    for (const _dk of Object.keys(_raw.devices || {})) {
      const _circuits = _raw.devices[_dk].heatingCircuits || {};
      const _ck = '0' in _circuits ? '0' : Object.keys(_circuits)[0];
      if (_ck !== undefined) return _circuits[_ck];
    }
  } catch(_) {}
  return null;
})();
const CURVE_SLOPE = _curveCli_slope > 0 ? _curveCli_slope : (_curveFromExplore?.slope ?? 0);
const CURVE_SHIFT = _curveCli_shift !== '' ? parseFloat(_curveCli_shift) : (_curveFromExplore?.shift ?? 0);
const hasBoilerKW = BOILER_KW > 0;
const hasCurve    = CURVE_SLOPE > 0;

// --- Heating curve: Viessmann uses a non-linear curve fitted from ViCare app data ---
// Real app points for slope=1.3,shift=6: (+20°,29°),(+10°,45°),(0°,57°),(-10°,68°),(-20°,80°),(-30°,82°)
// Cubic fit coefficients are computed from the 6 known points for the reference slope=1.3,shift=6
// For other slope/shift values we scale around the reference and apply shift offset
const heatingCurveLine = (() => {
  if (!hasCurve) return null;
  // Reference cubic coefficients (slope=1.3, shift=6, from ViCare app)
  // p(t) = 2.222e-4*t^3 - 9.167e-3*t^2 - 1.309*t + 57.52
  const refSlope = 1.3, refShift = 6;
  const refCoeffs = [2.222e-4, -9.167e-3, -1.309, 57.52];
  const poly = (t, c) => c[0]*t**3 + c[1]*t**2 + c[2]*t + c[3];
  const pts = [];
  for (let t = -30; t <= 22; t += 1) {
    // Scale: adjust for different slope (linear scaling of the curve steepness)
    // and shift (vertical offset adjustment)
    const refVal = poly(t, refCoeffs);
    // Slope adjustment: scale the deviation from room temp (20°C) by slope ratio
    const slopeAdj = (CURVE_SLOPE / refSlope);
    const shiftAdj = CURVE_SHIFT - refShift;
    const val = 20 + (refVal - 20) * slopeAdj + shiftAdj;
    pts.push({ x: t, y: +val.toFixed(1) });
  }
  return pts;
})();

// Override avgHeatDemand with correct nominal power if provided
const avgModActive = activeBurnerRows.length
  ? activeBurnerRows.reduce((s,r) => s + toNum(r.modulation), 0) / activeBurnerRows.length
  : null;
const heatDemandKW = (hasBoilerKW && avgModActive !== null)
  ? (BOILER_KW * avgModActive / 100).toFixed(1)
  : null;

// House heat loss coefficient  [kW/°C]
const avgRoomNum    = avgRoom    ? parseFloat(avgRoom)    : null;
const avgOutsideNum = avg(boilerRows, 'outside_temp') ? parseFloat(avg(boilerRows, 'outside_temp')) : null;
const deltaT        = (avgRoomNum !== null && avgOutsideNum !== null) ? avgRoomNum - avgOutsideNum : null;
const heatLossCoeff = (heatDemandKW !== null && deltaT !== null && deltaT > 0)
  ? (parseFloat(heatDemandKW) / deltaT).toFixed(2)
  : null;

// House efficiency rating
function houseEffRating(coeff) {
  if (coeff === null) return null;
  const c = parseFloat(coeff);
  if (c < 0.25) return { label: T('excellent'), cls: 'good' };
  if (c < 0.40) return { label: T('good'),      cls: 'good' };
  if (c < 0.60) return { label: T('average'),   cls: 'warn' };
  return             { label: T('poor'),        cls: 'bad'  };
}
const houseEff = houseEffRating(heatLossCoeff);

// Estimated peak load at design temperature
const peakLoadKW = (heatLossCoeff !== null && avgRoomNum !== null)
  ? (parseFloat(heatLossCoeff) * (avgRoomNum - DESIGN_TEMP)).toFixed(1)
  : null;

// Boiler sizing check
const boilerOversized = (hasBoilerKW && peakLoadKW !== null && BOILER_KW > parseFloat(peakLoadKW) * 2);

// Cycle diagnostics — use API delta values (real), not CSV edge counts (severely undersampled)
const reportHours   = DAYS * 24;
// cyclesPerHour: prefer real API delta; CSV edge fallback only if no delta available
const cyclesPerHour = sph || (cycleCount && reportHours ? (cycleCount / reportHours).toFixed(2) : null);
// avgCycleDurNum: prefer real API-derived value
const avgCycleDurNum  = realAvgDur ? parseFloat(realAvgDur) : (avgCycleDur ? parseFloat(avgCycleDur) : null);
const shortCycling    = avgCycleDurNum !== null && avgCycleDurNum < 5;
const excessiveCycling = cyclesPerHour !== null && parseFloat(cyclesPerHour) > 6;
// Note: with real API data, Vitodens typically shows 6-12 starts/hour in partial load,
// which is expected behavior. Only flag if combined with short avg duration.

// Flow temp heuristic
const avgFlowNum    = avgFlow ? parseFloat(avgFlow) : null;
const avgOutNum     = avgOutsideNum;
const highFlowTemp  = avgFlowNum !== null && avgOutNum !== null && avgFlowNum > 55 && avgOutNum > 5;

// Inefficient operation: low modulation + short cycles
const avgModNum = avgMod ? parseFloat(avgMod) : null;
const inefficientOp = avgModNum !== null && avgCycleDurNum !== null && avgModNum < 25 && avgCycleDurNum < 6;

// Build assistant insights
const insights = [];
if (shortCycling || excessiveCycling)
  insights.push({ type:'warn', text: shortCycling
    ? T('insightShortCycling', {dur: realAvgDur ?? avgCycleDur, sph: cyclesPerHour})
    : T('insightHighCycling',  {sph: cyclesPerHour}) });
if (inefficientOp)
  insights.push({ type:'warn', text: T('insightLowMod', {mod: avgMod}) });
if (highFlowTemp)
  insights.push({ type:'warn', text: T('insightHighFlow', {flow: avgFlow, out: avgOutsideNum?.toFixed(1)}) });
if (boilerOversized)
  insights.push({ type:'info', text: T('insightOversized', {kw: BOILER_KW, peak: peakLoadKW}) });
if (houseEff && (houseEff.cls === 'good'))
  insights.push({ type:'good', text: T('insightGoodHouse', {rating: houseEff.label, coeff: heatLossCoeff}) });
if (!hasBoilerKW)
  insights.push({ type:'info', text: T('insightAddBoilerKW') });
if (insights.length === 0 && hasBoilerKW)
  insights.push({ type:'good', text: T('insightNoIssues') });

// ── Comfort stability: stddev of room temperature ────────────────────────────
const roomTemps = hcRows.map(r => parseFloat(r.room_temp)).filter(v => !isNaN(v) && v > 0);
let comfortStddev = null, comfortRating = null, comfortCls = 'neutral';
if (roomTemps.length >= 10) {
  const mean = roomTemps.reduce((a,b) => a+b, 0) / roomTemps.length;
  comfortStddev = Math.sqrt(roomTemps.reduce((a,v) => a + (v-mean)**2, 0) / roomTemps.length).toFixed(2);
  const sd = parseFloat(comfortStddev);
  if (sd < 0.2)      { comfortRating = T('excellent'); comfortCls = 'good'; }
  else if (sd < 0.5) { comfortRating = T('good');      comfortCls = 'good'; }
  else               { comfortRating = T('unstable');  comfortCls = 'warn'; }
}

// ── Cycling severity score ───────────────────────────────────────────────────
// score = cyclesPerHour × (10 / avgCycleDuration)  →  <1 excellent, 1-3 ok, >3 severe
let cyclingScore = null, cyclingSeverity = null, cyclingSeverityCls = 'neutral';
if (cyclesPerHour && avgCycleDurNum && avgCycleDurNum > 0) {
  // Score uses real API counter data — not CSV edge count
  // cyclingScore: starts/hour × (6 / avgCycleDur) — normalized to 6-min reference cycle
  // sph is wall-clock starts/hour; avgCycleDurNum is actual avg duration
  cyclingScore = (parseFloat(cyclesPerHour) * (6 / Math.max(1, avgCycleDurNum))).toFixed(1);
  const sc2 = parseFloat(cyclingScore);
  if (sc2 < 1.5)    { cyclingSeverity = T('good');       cyclingSeverityCls = 'good'; }
  else if (sc2 < 3) { cyclingSeverity = T('average');   cyclingSeverityCls = 'warn'; }
  else if (sc2 < 6) { cyclingSeverity = T('badgeHigh');        cyclingSeverityCls = 'warn'; }
  else              { cyclingSeverity = T('badgeSevere');      cyclingSeverityCls = 'bad';  }
  if (sc2 >= 6)
    insights.push({ type:'warn', text: T('insightCyclingSevere', {score: cyclingScore, sph: cyclesPerHour, dur: avgCycleDurNum.toFixed(1)}) });
  else if (sc2 >= 3)
    insights.push({ type:'warn', text: T('insightCyclingHigh', {score: cyclingScore, sph: cyclesPerHour, dur: avgCycleDurNum.toFixed(1)}) });
}

// ── Min modulation check ─────────────────────────────────────────────────────
const minModCheck = (avgModNum !== null && avgModNum < 20 && avgCycleDurNum !== null && avgCycleDurNum < 10);
if (minModCheck)
  insights.push({ type:'warn', text: T('insightMinMod', {mod: avgMod}) });

// ── Minimum boiler power estimate ────────────────────────────────────────────
// Viessmann Vitodens 100: min modulation typically 10–15%
const MIN_MOD_PCT = 10; // conservative estimate
const minBoilerPow = hasBoilerKW ? +(BOILER_KW * MIN_MOD_PCT / 100).toFixed(1) : null;
const demandKW = heatDemandKW ? parseFloat(heatDemandKW) : null;
const oversizingRatio = (minBoilerPow && demandKW && demandKW > 0)
  ? (minBoilerPow / demandKW).toFixed(1) : null;
const structuralCycling = oversizingRatio && parseFloat(oversizingRatio) > 1.0;

// ── Build recommendations (actionable, structured) ────────────────────────────
const recommendations = [];

// Rec 1: Structural cycling due to oversizing
if (structuralCycling && hasBoilerKW) {
  const rec = TR('recOversizingActions');
  const suggestedShift = CURVE_SHIFT > 0 ? Math.max(0, CURVE_SHIFT - 3) : null;
  const suggestedSlope = CURVE_SLOPE > 0 ? Math.max(0.5, CURVE_SLOPE - 0.2).toFixed(1) : null;
  recommendations.push({
    type: 'warn',
    title: rec.title
      ?.replaceAll('{ratio}', oversizingRatio),
    body: rec.body
      ?.replaceAll('{minPow}', minBoilerPow)
       .replaceAll('{demand}', demandKW?.toFixed(1)),
    actions: rec.actions?.map(a => a
      .replaceAll('{slope}', CURVE_SLOPE || '—')
      .replaceAll('{shift}', CURVE_SHIFT ?? '—')
    ),
    impact: rec.impact,
  });
}

// Rec 2: Flow temp above curve
if (hasCurve && avgFlowNum && avgOutNum !== null) {
  const theoreticalFlow = heatingCurveLine?.find(p => Math.abs(p.x - Math.round(avgOutNum)) <= 0.5)?.y;
  const delta = theoreticalFlow ? (avgFlowNum - theoreticalFlow).toFixed(1) : null;
  if (delta && parseFloat(delta) > 5) {
    const rec = TR('recHighFlow');
    const suggestShift = Math.round(parseFloat(delta));
    const newShift = CURVE_SHIFT !== undefined ? CURVE_SHIFT - suggestShift : null;
    const newSlope = CURVE_SLOPE ? Math.max(0.5, CURVE_SLOPE - 0.2).toFixed(1) : null;
    recommendations.push({
      type: 'warn',
      title: rec.title,
      body: rec.body
        ?.replaceAll('{flow}', avgFlowNum.toFixed(1))
         .replaceAll('{out}', avgOutNum.toFixed(1))
         .replaceAll('{curve}', theoreticalFlow)
         .replaceAll('{delta}', delta),
      actions: rec.actions?.map(a => a
        .replaceAll('{suggestShift}', suggestShift)
        .replaceAll('{shift}', CURVE_SHIFT ?? '—')
        .replaceAll('{newShift}', newShift ?? '—')
        .replaceAll('{slope}', CURVE_SLOPE || '—')
        .replaceAll('{newSlope}', newSlope ?? '—')
      ),
      impact: rec.impact,
    });
  }
}

// ── Gas efficiency: estimated kWh produced per m³ gas ───────────────────────
// heatProduced (kWh) = avgHeatDemand(kW) × burnerRuntime(h)
// gasUsed (m³) from latest daily reading × days
// 1 m³ natural gas ≈ 10.6 kWh (lower heating value)
const GAS_KWH_PER_M3 = 10.6;
let gasEfficiencyPct = null;
if (hasBoilerKW && heatDemandKW && burnerHours && hasGasData) {
  // total gas used in period: sum of daily maxes
  const totalGasM3 = gasDays.reduce((sum, d) => sum + gasPerDay[d].heating + gasPerDay[d].dhw, 0);
  // burner runtime in period (hours): use last - first burner_hours from boilerRows
  const firstBH = parseFloat(boilerRows[0]?.burner_hours || 0);
  const lastBH  = parseFloat(lb.burner_hours || 0);
  const runtimeH = lastBH - firstBH;
  if (totalGasM3 > 0 && runtimeH > 0) {
    const heatProduced = parseFloat(heatDemandKW) * runtimeH;
    const gasInputKwh  = totalGasM3 * GAS_KWH_PER_M3;
    gasEfficiencyPct   = Math.min(110, (heatProduced / gasInputKwh * 100)).toFixed(0);
  }
}

// ── Heating curve behaviour: correlation flow vs outdoor ─────────────────────
// Pearson correlation: negative = correct curve, ~0 = fixed flow, positive = misconfigured
let heatCurveCorr = null, heatCurveBehaviour = null, heatCurveCls = 'neutral';
const corrPairs = hcRows
  .map(r => {
    const flow = parseFloat(r.flow_temp);
    const out  = parseFloat(r.outside_temp) || parseFloat(
      boilerRows.find(b => b.timestamp === r.timestamp)?.outside_temp || ''
    );
    return (isNaN(flow) || isNaN(out) || flow <= 0 || out === 0) ? null : [out, flow];
  })
  .filter(Boolean);

// Also try matching outdoor from boilerRows by nearest timestamp
const corrPairs2 = (() => {
  const bySorted = [...boilerRows].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
  return hcRows.map(r => {
    const flow = parseFloat(r.flow_temp);
    if (isNaN(flow) || flow <= 0) return null;
    const t = new Date(r.timestamp).getTime();
    let best = null, bd = Infinity;
    for (const b of bySorted) {
      const d = Math.abs(new Date(b.timestamp).getTime() - t);
      if (d < bd) { bd = d; best = b; }
    }
    const out = best && bd < 30*60*1000 ? parseFloat(best.outside_temp) : NaN;
    return (!isNaN(out) && out !== 0) ? [out, flow] : null;
  }).filter(Boolean);
})();

const usePairs = corrPairs2.length >= corrPairs.length ? corrPairs2 : corrPairs;
if (usePairs.length >= 20) {
  const n  = usePairs.length;
  const mx = usePairs.reduce((a,p) => a+p[0], 0) / n;
  const my = usePairs.reduce((a,p) => a+p[1], 0) / n;
  const num = usePairs.reduce((a,p) => a + (p[0]-mx)*(p[1]-my), 0);
  const den = Math.sqrt(usePairs.reduce((a,p) => a+(p[0]-mx)**2, 0) * usePairs.reduce((a,p) => a+(p[1]-my)**2, 0));
  heatCurveCorr = den > 0 ? (num/den).toFixed(2) : null;
  if (heatCurveCorr !== null) {
    const c = parseFloat(heatCurveCorr);
    if (c < -0.3)      { heatCurveBehaviour = T('weatherComp'); heatCurveCls = 'good'; }
    else if (c < 0.1)  { heatCurveBehaviour = T('fixedFlow');        heatCurveCls = 'warn'; }
    else               { heatCurveBehaviour = T('checkCurve');     heatCurveCls = 'bad';  }
    if (c >= 0.1)
      insights.push({ type:'warn', text: T('insightCurveMiscfg', {r: heatCurveCorr}) });
    else if (c > -0.3 && c < 0.1)
      insights.push({ type:'info', text: T('insightFixedFlow', {r: heatCurveCorr}) });
    // Rec 3: weather comp not active — add to recommendations
    const rec3 = TR('recNoWeatherComp');
    recommendations.push({
      type: 'info',
      title: rec3.title,
      body: rec3.body?.replaceAll('{r}', heatCurveCorr),
      actions: rec3.actions?.map(a => a
        .replaceAll('{slope}', CURVE_SLOPE || '—')
        .replaceAll('{shift}', CURVE_SHIFT ?? '—')
      ),
      impact: rec3.impact,
    });
  }
}

// ── Scatter data: heat demand vs outdoor temp ─────────────────────────────────
// Each point: x=outside_temp, y=heatDemand(kW) when burner active
const scatterData = (() => {
  if (!hasBoilerKW) return [];
  return boilerRows
    .filter(r => r.burner_active === 'true' && parseFloat(r.modulation) > 0)
    .map(r => {
      // find nearest boilerRow with outside_temp
      const out = parseFloat(r.outside_temp);
      const mod = parseFloat(r.modulation);
      if (isNaN(out) || out === 0 || isNaN(mod)) return null;
      return { x: out, y: +(BOILER_KW * mod / 100).toFixed(2) };
    })
    .filter(Boolean);
})();

// Linear regression on scatter for trendline
const scatterRegression = (() => {
  if (scatterData.length < 10) return null;
  const n  = scatterData.length;
  const mx = scatterData.reduce((a,p) => a+p.x, 0) / n;
  const my = scatterData.reduce((a,p) => a+p.y, 0) / n;
  const num = scatterData.reduce((a,p) => a + (p.x-mx)*(p.y-my), 0);
  const den = scatterData.reduce((a,p) => a + (p.x-mx)**2, 0);
  if (den === 0) return null;
  const slope     = num / den;
  const intercept = my - slope * mx;
  // balance point: outdoor temp where heat demand = 0
  const balancePoint = slope !== 0 ? (-intercept / slope).toFixed(1) : null;
  // trendline: two points covering outdoor range
  const xs = scatterData.map(p => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  return {
    slope: slope.toFixed(3), intercept: intercept.toFixed(2), balancePoint,
    line: [
      { x: xMin, y: +(slope*xMin + intercept).toFixed(2) },
      { x: xMax, y: +(slope*xMax + intercept).toFixed(2) }
    ]
  };
})();

// Histogram buckets: 0-5, 5-10, 10-20, 20-40, 40+
const histBuckets = [
  { label:'0–5 min',  min:0,  max:5  },
  { label:'5–10 min', min:5,  max:10 },
  { label:'10–20 min',min:10, max:20 },
  { label:'20–40 min',min:20, max:40 },
  { label:'40+ min',  min:40, max:Infinity }
];
const histData = histBuckets.map(b => cycles.filter(d => d >= b.min && d < b.max).length);

const programs = {};
hcRows.forEach(r => { if (r.program) programs[r.program] = (programs[r.program]||0)+1; });
const totalProg = Object.values(programs).reduce((a,b)=>a+b,0);
const progDist = Object.entries(programs).map(([k,v]) => { const key = 'prog'+k.charAt(0).toUpperCase()+k.slice(1); return { label: T(key) || k.charAt(0).toUpperCase()+k.slice(1), cssKey: k, pct: ((v/totalProg)*100).toFixed(0) }; });

function subsample(arr, max=200) {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length/max);
  return arr.filter((_,i) => i%step===0);
}
function chartData(arr, key) {
  const s = subsample(arr);
  return {
    labels: s.map(r => { const d=new Date(r.timestamp); return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`; }),
    values: s.map(r => toNum(r[key])||null)
  };
}

const modChart    = chartData(boilerRows, 'modulation');
const roomChart   = chartData(hcRows, 'room_temp');
const targetChart = chartData(hcRows, 'target_temp');
const flowChart   = chartData(hcRows, 'flow_temp');
const dhwChart    = chartData(dhwRows, 'dhw_temp');
const dhwTgtChart = chartData(dhwRows, 'dhw_target');
const outsideChart = chartData(boilerRows, 'outside_temp');
// Energy charts
const pvChart      = chartData(energyRows, 'pv_production_w');
const battChart    = chartData(energyRows, 'battery_level');
const battChrChart = chartData(energyRows, 'battery_charging_w');
const battDisChart = chartData(energyRows, 'battery_discharging_w');
const wallboxChart = chartData(energyRows, 'wallbox_power_w');
const sBurner     = subsample(boilerRows);
const burnerChart = {
  labels: sBurner.map(r => { const d=new Date(r.timestamp); return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`; }),
  values: sBurner.map(r => r.burner_active==='true' ? 1 : 0)
};

// --- Overview chart: merge all rows on a unified timeline ---
// Build a time-indexed map for each series, then interpolate to a shared timeline
const allTimes = [...new Set(filtered.map(r => r.timestamp))].sort();
const overviewTimes = subsample(allTimes, 200);
// Linear interpolation on a sorted array of rows
function interpolate(arr, ts, key) {
  const t = new Date(ts).getTime();
  const valid = arr.filter(r => r[key] !== '' && r[key] !== undefined && !isNaN(toNum(r[key])));
  if (!valid.length) return null;
  // exact match
  const exact = valid.find(r => new Date(r.timestamp).getTime() === t);
  if (exact) return toNum(exact[key]);
  // find prev and next
  let prev = null, next = null;
  for (const r of valid) {
    const rt = new Date(r.timestamp).getTime();
    if (rt <= t) prev = r;
    else if (rt > t && !next) next = r;
  }
  if (prev && next) {
    const t0 = new Date(prev.timestamp).getTime();
    const t1 = new Date(next.timestamp).getTime();
    const ratio = (t - t0) / (t1 - t0);
    return +(toNum(prev[key]) + ratio * (toNum(next[key]) - toNum(prev[key]))).toFixed(2);
  }
  // extrapolate up to 1 hour at edges
  if (prev && (t - new Date(prev.timestamp).getTime()) < 60*60*1000) return toNum(prev[key]);
  if (next && (new Date(next.timestamp).getTime() - t) < 60*60*1000) return toNum(next[key]);
  return null;
}
// Burner is stepped (boolean) — use nearest within 20 min, no interpolation
function lookupBurner(arr, ts) {
  const t = new Date(ts).getTime();
  let best = null, bestDiff = Infinity;
  for (const r of arr) {
    const diff = Math.abs(new Date(r.timestamp).getTime() - t);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return (best && bestDiff < 20*60*1000) ? (best.burner_active==='true' ? 100 : 0) : null;
}

const ovLabels   = overviewTimes.map(ts => { const d=new Date(ts); return `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit'})} ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}`; });
const scheduleBarHtml = buildScheduleBarHtml();
const ovRoom     = overviewTimes.map(ts => interpolate(hcRows,    ts, 'room_temp'));
const ovSetpoint = overviewTimes.map(ts => interpolate(hcRows,    ts, 'target_temp'));
const ovFlow     = overviewTimes.map(ts => interpolate(hcRows,    ts, 'flow_temp'));
const ovDhw      = overviewTimes.map(ts => interpolate(dhwRows,   ts, 'dhw_temp'));
const ovOutside  = overviewTimes.map(ts => interpolate(boilerRows, ts, 'outside_temp'));
const ovOutsideHum = overviewTimes.map(ts => interpolate(boilerRows, ts, 'outside_humidity'));
const ovMod      = overviewTimes.map(ts => interpolate(boilerRows,ts, 'modulation'));
const ovBurner   = overviewTimes.map(ts => lookupBurner(boilerRows, ts));



// ── D: Estimated return temperature + condensing score ──────────────────────
// T_return ≈ T_flow - ΔT(modulation)  — model-based, not measured
// ΔT = clamp(5, 15, 5 + 0.1 × modulation)
const MIN_DATA_DAYS = 30;  // threshold for statistically meaningful analysis

const condensingScore = (() => {
  const samples = hcRows
    .map(r => {
      const flow = parseFloat(r.flow_temp);
      const ts   = r.timestamp;
      // find nearest boiler row for modulation
      const b = boilerRows.reduce((best, br) => {
        const d = Math.abs(new Date(br.timestamp) - new Date(ts));
        return (!best || d < Math.abs(new Date(best.timestamp) - new Date(ts))) ? br : best;
      }, null);
      const mod = b ? parseFloat(b.modulation) : NaN;
      if (isNaN(flow) || flow <= 0 || isNaN(mod)) return null;
      const deltaT = Math.max(5, Math.min(15, 5 + 0.1 * mod));
      const tReturn = flow - deltaT;
      return { tReturn, flow, mod };
    })
    .filter(Boolean);

  if (samples.length < 10) return null;
  const condensing = samples.filter(s => s.tReturn < 55).length;
  return {
    pct:     Math.round(condensing / samples.length * 100),
    samples: samples.length,
    avgReturn: (samples.reduce((s,r) => s + r.tReturn, 0) / samples.length).toFixed(1),
  };
})();

// ── B: Heat loss line for scatter (Q = H × (T_indoor - T_outdoor)) ──────────
// Uses heatLossCoeff already computed above
const heatLossLine = (() => {
  if (!heatLossCoeff || !avgRoomNum) return null;
  const H = parseFloat(heatLossCoeff);
  const Ti = avgRoomNum;
  // Generate line from -15°C to +20°C outdoor
  return Array.from({length: 36}, (_, i) => {
    const tout = i - 15;
    const q = Math.max(0, H * (Ti - tout));
    return { x: tout, y: +q.toFixed(2) };
  });
})();

// ── E: Comfort vs efficiency (rolling 12h windows, normalised for outdoor temp) ─
const MIN_DAYS_COMFORT = 30;
const dataDays = [...new Set(boilerRows.map(r => r.timestamp.slice(0,10)))].length;
const hasEnoughForComfort = dataDays >= MIN_DAYS_COMFORT;

const comfortEfficiency = (() => {
  if (!hasEnoughForComfort) return { available: false, daysHave: dataDays, daysNeed: MIN_DAYS_COMFORT };

  const WINDOW_MS = 12 * 60 * 60 * 1000;
  const INDOOR_SET = avgRoomNum || 20;

  // Build merged timeline: timestamp, roomTemp, gasDelta, outdoorTemp
  const timeline = hcRows
    .map(r => {
      const ts  = new Date(r.timestamp).getTime();
      const rt  = parseFloat(r.room_temp);
      if (isNaN(rt) || rt <= 0) return null;
      // nearest boiler row
      const b = boilerRows.reduce((best, br) => {
        const d = Math.abs(new Date(br.timestamp).getTime() - ts);
        return (!best || d < Math.abs(new Date(best.timestamp).getTime() - ts)) ? br : best;
      }, null);
      const out = b ? parseFloat(b.outside_temp) : NaN;
      const gas = b ? parseFloat(b.gas_heating_day_m3) : NaN;
      return { ts, rt, out: isNaN(out) ? null : out, gas: isNaN(gas) ? null : gas };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  if (timeline.length < 20) return { available: false, daysHave: dataDays, daysNeed: MIN_DAYS_COMFORT };

  const windows = [];
  for (let i = 0; i < timeline.length; i++) {
    const win = timeline.filter(p => p.ts >= timeline[i].ts && p.ts < timeline[i].ts + WINDOW_MS);
    if (win.length < 5) continue;

    const temps = win.map(p => p.rt).filter(v => v != null);
    if (temps.length < 3) continue;
    const mean = temps.reduce((a,b) => a+b, 0) / temps.length;
    const stddev = Math.sqrt(temps.reduce((a,v) => a+(v-mean)**2, 0) / temps.length);

    // Gas normalised by heating degree
    let gasSum = 0, dtSum = 0;
    for (const p of win) {
      if (p.gas == null || p.out == null) continue;
      const dt = INDOOR_SET - p.out;
      if (dt <= 0) continue;
      gasSum += p.gas; dtSum += dt;
    }
    if (dtSum === 0) continue;
    const gasNorm = gasSum / dtSum;

    windows.push({ ts: timeline[i].ts, stability: stddev, gasNorm });
  }

  if (windows.length < 10) return { available: false, daysHave: dataDays, daysNeed: MIN_DAYS_COMFORT };

  // Split into first/second half for trend
  const half = Math.floor(windows.length / 2);
  const avg  = (arr, k) => arr.reduce((s,v) => s + v[k], 0) / arr.length;
  const s1   = avg(windows.slice(0, half), 'stability');
  const s2   = avg(windows.slice(half),    'stability');
  const g1   = avg(windows.slice(0, half), 'gasNorm');
  const g2   = avg(windows.slice(half),    'gasNorm');
  const dStability = ((s1 - s2) / Math.max(s1, 0.001) * 100).toFixed(1); // positive = improved
  const dGas       = ((g2 - g1) / Math.max(g1, 0.001) * 100).toFixed(1); // positive = more gas

  // Insight
  let insight = null;
  const ds = parseFloat(dStability), dg = parseFloat(dGas);
  if (Math.abs(ds) < 5 && dg > 5)
    insight = { type:'warn', key:'ceInsightGasNoComfort' };
  else if (ds > 5 && Math.abs(dg) < 10)
    insight = { type:'good', key:'ceInsightComfortFree' };
  else if (ds < -5 && dg > 5)
    insight = { type:'warn', key:'ceInsightBothWorse' };
  else
    insight = { type:'info', key:'ceInsightStable' };

  return {
    available: true,
    windows,
    dStability, dGas,
    avgStability: (windows.reduce((s,w) => s+w.stability, 0) / windows.length).toFixed(3),
    avgGasNorm:   (windows.reduce((s,w) => s+w.gasNorm, 0) / windows.length).toFixed(3),
    insight,
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// GAS FORECAST
// Uses gasPerDay (already computed above) to project monthly/annual consumption.
// Strategy: linear regression on last N days → extrapolate to 30/365 days.
// ─────────────────────────────────────────────────────────────────────────────
let gasForecast = null;
if (gasDays.length >= 3) {
  // Use all available days; total = heating + dhw
  const totalPerDay = gasDays.map(d => gasPerDay[d].heating + gasPerDay[d].dhw);
  const n = totalPerDay.length;
  // Simple linear regression: y = a + b*x  (x = day index)
  const xMean = (n - 1) / 2;
  const yMean = totalPerDay.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  totalPerDay.forEach((y, i) => { num += (i - xMean) * (y - yMean); den += (i - xMean) ** 2; });
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  // Project from today (index = n-1) forward
  const projectDay = (offset) => Math.max(0, intercept + slope * (n - 1 + offset));
  // Monthly: sum of next 30 days
  let monthSum = 0;
  for (let i = 1; i <= 30; i++) monthSum += projectDay(i);
  // Annual: sum of next 365 days (approximated as 30-day avg × 12 with seasonal note)
  // For simplicity: annualise the period avg × 365 (more stable than long regression)
  const periodAvgPerDay = yMean;
  const annualEst = periodAvgPerDay * 365;
  // Cost estimate (€): use --gasPriceEur param or env (default 0.90 €/m³ — Italian average)
  const GAS_PRICE = parseFloat(getArg('--gasPriceEur', process.env.GAS_PRICE_EUR || '0.90'));
  // Annual estimate requires at least 14 days to avoid misleading projections
  // from short atypical periods (e.g. unusually cold/warm week).
  const ANNUAL_MIN_DAYS = 14;
  const hasEnoughForAnnual = n >= ANNUAL_MIN_DAYS;
  gasForecast = {
    avgPerDay:         yMean.toFixed(2),
    trend:             slope > 0.05 ? 'rising' : slope < -0.05 ? 'falling' : 'stable',
    trendSlope:        slope.toFixed(3),
    month30:           monthSum.toFixed(1),
    annualEst:         hasEnoughForAnnual ? annualEst.toFixed(0) : null,
    costMonth:         (monthSum * GAS_PRICE).toFixed(2),
    costAnnual:        hasEnoughForAnnual ? (annualEst * GAS_PRICE).toFixed(2) : null,
    gasPrice:          GAS_PRICE.toFixed(2),
    daysUsed:          n,
    annualMinDays:     ANNUAL_MIN_DAYS,
    hasEnoughForAnnual,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HOURLY HEATMAP — burner runtime % and avg outside temp per hour-of-day
// Rows with event_type='snapshot' or no event_type (legacy) only — not events
// ─────────────────────────────────────────────────────────────────────────────
const hourlyStats = (() => {
  const buckets = {};
  for (let h = 0; h < 24; h++) buckets[h] = { onCount: 0, total: 0, tempSum: 0, tempCount: 0, gasSum: 0 };

  // Group gas per day so we can attribute daily gas to hourly slots
  const gasPerDayH = {};
  boilerRows.forEach(r => {
    if (!r.gas_heating_day_m3 && !r.gas_dhw_day_m3) return;
    const day = r.timestamp.slice(0, 10);
    const g = (parseFloat(r.gas_heating_day_m3)||0) + (parseFloat(r.gas_dhw_day_m3)||0);
    if (!gasPerDayH[day] || g > gasPerDayH[day]) gasPerDayH[day] = g;
  });

  boilerRows.forEach(r => {
    const h = new Date(r.timestamp).getHours();
    buckets[h].total++;
    if (r.burner_active === 'true') buckets[h].onCount++;
    const t = parseFloat(r.outside_temp);
    if (!isNaN(t) && t !== 0) { buckets[h].tempSum += t; buckets[h].tempCount++; }
  });

  return Array.from({length: 24}, (_, h) => {
    const b = buckets[h];
    return {
      hour: h,
      label: String(h).padStart(2,'0') + ':00',
      runtimePct: b.total > 0 ? Math.round((b.onCount / b.total) * 100) : 0,
      avgOutside:  b.tempCount > 0 ? +(b.tempSum / b.tempCount).toFixed(1) : null,
    };
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// DAILY EFFICIENCY — heat produced / gas consumed per calendar day (from CSV)
// Uses heat_heating_day_kwh + gas_heating_day_m3 columns (plugin >= v2.0.50)
// ─────────────────────────────────────────────────────────────────────────────
const dailyEfficiency = (() => {
  const GAS_PCS = 10.55; // kWh per m³ higher heating value
  const perDay = {};
  boilerRows.forEach(r => {
    const day = r.timestamp.slice(0, 10);
    const heat = parseFloat(r.heat_heating_day_kwh);
    const gas  = parseFloat(r.gas_heating_day_m3);
    if (!isNaN(heat) && heat > 0 && !isNaN(gas) && gas > 0.1) {
      if (!perDay[day]) perDay[day] = { heat: 0, gas: 0 };
      // Take max within day (daily cumulative values grow during the day)
      if (heat > perDay[day].heat) perDay[day].heat = heat;
      if (gas  > perDay[day].gas)  perDay[day].gas  = gas;
    }
  });
  const days = Object.keys(perDay).sort();
  return {
    labels: days.map(d => { const [y,m,dd]=d.split('-'); return `${dd}/${m}`; }),
    values: days.map(d => {
      const eff = Math.min(110, Math.round((perDay[d].heat / (perDay[d].gas * GAS_PCS)) * 100));
      return eff;
    }),
    hasData: days.length >= 2,
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// ENERGY FLOW — daily PV / battery / grid / wallbox aggregation (from CSV)
// ─────────────────────────────────────────────────────────────────────────────
const energyFlow = (() => {
  if (!energyRows.length) return null;
  const perDay = {};
  energyRows.forEach(r => {
    const day = r.timestamp.slice(0, 10);
    if (!perDay[day]) perDay[day] = { pv: 0, battChr: 0, battDis: 0, gridFeed: 0, gridDraw: 0, wallbox: 0, count: 0 };
    const d = perDay[day];
    // Average within day (these are instantaneous W readings)
    d.pv       += parseFloat(r.pv_production_w)   || 0;
    d.battChr  += parseFloat(r.battery_charging_w) || 0;
    d.battDis  += parseFloat(r.battery_discharging_w) || 0;
    d.gridFeed += parseFloat(r.grid_feedin_w)      || 0;
    d.gridDraw += parseFloat(r.grid_draw_w)         || 0;
    d.wallbox  += parseFloat(r.wallbox_power_w)    || 0;
    d.count++;
  });
  const days = Object.keys(perDay).sort();
  const avg = (d, k) => d.count > 0 ? Math.round(perDay[d][k] / perDay[d].count) : 0;
  return {
    labels:    days.map(d => { const [y,m,dd]=d.split('-'); return `${dd}/${m}`; }),
    pv:        days.map(d => avg(d,'pv')),
    battChr:   days.map(d => avg(d,'battChr')),
    battDis:   days.map(d => avg(d,'battDis')),
    gridFeed:  days.map(d => avg(d,'gridFeed')),
    gridDraw:  days.map(d => avg(d,'gridDraw')),
    wallbox:   days.map(d => avg(d,'wallbox')),
    hasData:   days.length >= 2 && (hasPV || hasBattery),
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// VIESSMANN STATUS / ERROR CODE TRANSLATIONS
// Source: Viessmann service documentation + vieventlog error_codes.go
// ─────────────────────────────────────────────────────────────────────────────
const VIESSMANN_CODES = {
  // ── Status codes (S.) ──
  'S.0':   { en: 'Standby',                         de: 'Bereitschaft' },
  'S.1':   { en: 'DHW heating',                     de: 'Warmwasserbereitung' },
  'S.2':   { en: 'Central heating',                 de: 'Heizbetrieb' },
  'S.3':   { en: 'Burner on',                       de: 'Brenner ein' },
  'S.4':   { en: 'Burner off',                      de: 'Brenner aus' },
  'S.5':   { en: 'Fan pre-purge',                   de: 'Lüfter Vorspülung' },
  'S.6':   { en: 'Ignition',                        de: 'Zündung' },
  'S.7':   { en: 'Flame detected',                  de: 'Flamme erkannt' },
  'S.8':   { en: 'Burner post-purge',               de: 'Lüfter Nachspülung' },
  'S.9':   { en: 'Cooling mode',                    de: 'Kühlbetrieb' },
  'S.10':  { en: 'Frost protection active',         de: 'Frostschutz aktiv' },
  'S.12':  { en: 'Circulation pump active',         de: 'Umwälzpumpe aktiv' },
  'S.17':  { en: 'Flue gas test',                   de: 'Abgastest' },
  'S.19':  { en: 'Chimney sweep mode',              de: 'Schornsteinfegerbetrieb' },
  'S.20':  { en: 'Boiler protection (overtemp)',    de: 'Kesselschutz (Übertemperatur)' },
  'S.22':  { en: 'External demand active',          de: 'Externe Anforderung aktiv' },
  'S.24':  { en: 'Pump overrun',                    de: 'Pumpennachlauf' },
  'S.31':  { en: 'Summer eco mode',                 de: 'Sommer-Eco-Betrieb' },
  'S.32':  { en: 'Heating circuit standby',         de: 'Heizkreis Standby' },
  'S.40':  { en: 'Heat pump heating',               de: 'Wärmepumpe Heizbetrieb' },
  'S.41':  { en: 'Heat pump DHW',                   de: 'Wärmepumpe Warmwasser' },
  'S.42':  { en: 'Heat pump defrost',               de: 'Wärmepumpe Abtauung' },
  'S.43':  { en: 'Heat pump cooling',               de: 'Wärmepumpe Kühlung' },
  'S.44':  { en: 'Compressor starting',             de: 'Verdichter startet' },
  'S.45':  { en: 'Compressor running',              de: 'Verdichter läuft' },
  'S.46':  { en: 'Compressor stopping',             de: 'Verdichter stoppt' },
  'S.100': { en: 'Heating mode',                    de: 'Heizbetrieb' },
  'S.109': { en: 'Heating circuit active',          de: 'Heizkreis aktiv' },
  'S.111': { en: 'Normal heating program',          de: 'Normalbetrieb Heizung' },
  'S.112': { en: 'Reduced heating program',         de: 'Absenkbetrieb Heizung' },
  'S.113': { en: 'Comfort heating program',         de: 'Komfortbetrieb Heizung' },
  'S.114': { en: 'DHW demand',                      de: 'Warmwasseranforderung' },
  'S.118': { en: 'Primary circuit active',          de: 'Primärkreis aktiv' },
  'S.119': { en: 'Secondary circuit active',        de: 'Sekundärkreis aktiv' },
  'S.120': { en: 'Circulation pump running',        de: 'Umwälzpumpe läuft' },
  'S.123': { en: 'Heat pump standby',               de: 'Wärmepumpe Bereitschaft' },
  'S.124': { en: 'Heat pump grid lock',             de: 'Wärmepumpe Netzsperrzeit' },
  'S.125': { en: 'Heat pump demand pending',        de: 'Wärmepumpe Anforderung ausstehend' },
  'S.126': { en: 'Heat pump frost protection',      de: 'Wärmepumpe Frostschutz' },
  'S.130': { en: 'Defrost active',                  de: 'Abtauung aktiv' },
  'S.131': { en: 'Defrost completed',               de: 'Abtauung abgeschlossen' },
  'S.134': { en: 'Heat pump heating active',        de: 'Wärmepumpe Heizbetrieb aktiv' },
  'S.140': { en: 'Smart grid active',               de: 'Smart Grid aktiv' },
  'S.200': { en: 'Legionella protection',           de: 'Legionellenschutz' },
  'S.201': { en: 'DHW efficient mode',              de: 'Warmwasser Effizienzbetrieb' },
  'S.202': { en: 'DHW comfort mode',                de: 'Warmwasser Komfortbetrieb' },
  // ── Info codes (I.) ──
  'I.0':   { en: 'System OK',                       de: 'System OK' },
  'I.1':   { en: 'Maintenance due',                 de: 'Wartung fällig' },
  'I.2':   { en: 'Filter replacement due',          de: 'Filterwechsel fällig' },
  'I.10':  { en: 'External temperature sensor fault', de: 'Außentemperaturfühler Fehler' },
  'I.11':  { en: 'Return temperature sensor fault', de: 'Rücklauftemperaturfühler Fehler' },
  'I.12':  { en: 'DHW sensor fault',                de: 'Warmwasserfühler Fehler' },
  'I.20':  { en: 'Low water pressure warning',      de: 'Niederdruck Warnung' },
  'I.100': { en: 'System info',                     de: 'Systeminformation' },
  'I.113': { en: 'Heating curve optimisation info', de: 'Heizkurvenoptimierung Info' },
  'I.114': { en: 'Energy balance info',             de: 'Energiebilanz Info' },
  'I.115': { en: 'Runtime statistics info',         de: 'Laufzeitstatistik Info' },
  // ── Fault codes (F.) ──
  'F.0':   { en: 'No fault',                        de: 'Kein Fehler' },
  'F.1':   { en: 'Burner fault — no ignition',      de: 'Brennerstörung — keine Zündung' },
  'F.2':   { en: 'Flame signal lost',               de: 'Flammensignal verloren' },
  'F.3':   { en: 'Ignition fault',                  de: 'Zündfehler' },
  'F.4':   { en: 'Safety chain open',               de: 'Sicherheitskette offen' },
  'F.5':   { en: 'Gas valve fault',                 de: 'Gasventil Fehler' },
  'F.7':   { en: 'Flue gas sensor fault',           de: 'Abgastemperaturfühler Fehler' },
  'F.9':   { en: 'Supply sensor fault',             de: 'Vorlauftemperaturfühler Fehler' },
  'F.10':  { en: 'External sensor fault',           de: 'Außenfühler Fehler' },
  'F.11':  { en: 'Return sensor fault',             de: 'Rücklauftemperaturfühler Fehler' },
  'F.12':  { en: 'DHW sensor fault',                de: 'Warmwasserfühler Fehler' },
  'F.20':  { en: 'Safety temperature limiter',      de: 'Sicherheitstemperaturbegrenzer' },
  'F.22':  { en: 'Low water pressure fault',        de: 'Wassermangel' },
  'F.23':  { en: 'Pump fault — overtemp',           de: 'Pumpe Fehler — Übertemperatur' },
  'F.24':  { en: 'Pump circulation fault',          de: 'Pumpe Zirkulationsfehler' },
  'F.28':  { en: 'Ignition fault (gas)',            de: 'Zündstörung (Gas)' },
  'F.29':  { en: 'Flame fault after ignition',      de: 'Flammenfehler nach Zündung' },
  'F.30':  { en: 'STB safety shutdown',             de: 'STB Sicherheitsabschaltung' },
  'F.31':  { en: 'Boiler overtemperature',          de: 'Kesselübertemperatur' },
  'F.32':  { en: 'Flue overtemperature',            de: 'Abgasübertemperatur' },
  'F.33':  { en: 'Draft fault',                     de: 'Zugfehler' },
  'F.36':  { en: 'Fan fault',                       de: 'Lüfter Fehler' },
  'F.40':  { en: 'Compressor fault',                de: 'Verdichter Fehler' },
  'F.41':  { en: 'Refrigerant circuit fault',       de: 'Kältemittelkreis Fehler' },
  'F.42':  { en: 'Defrost fault',                   de: 'Abtaufehler' },
  'F.50':  { en: 'Communication fault gateway',     de: 'Kommunikationsfehler Gateway' },
  'F.51':  { en: 'Communication fault controller', de: 'Kommunikationsfehler Regler' },
  'F.52':  { en: 'Bus fault',                       de: 'Busfehler' },
  'F.60':  { en: 'Expansion vessel fault',          de: 'Ausdehnungsgefäß Fehler' },
  'F.73':  { en: 'Water pressure too high',         de: 'Wasserdruck zu hoch' },
  'F.74':  { en: 'Water pressure too low',          de: 'Wasserdruck zu niedrig' },
  'F.75':  { en: 'Pump speed sensor fault',         de: 'Pumpendrehzahlsensor Fehler' },
};

function translateCode(code) {
  if (!code) return null;
  const entry = VIESSMANN_CODES[code];
  if (entry) return entry.en;
  // Partial match fallback (e.g. S.134 → try S.13 → S.1)
  const parts = code.split('.');
  if (parts.length === 2) {
    const shorter = parts[0] + '.' + parts[1].slice(0, -1);
    if (VIESSMANN_CODES[shorter]) return VIESSMANN_CODES[shorter].en + ' (variant)';
  }
  return null;
}

// Extract device messages from the latest API data snapshot (if available via CSV extension)
// For now we show the codes from the last row that has error_code-like fields
// (future: read from a separate messages JSON file written by the plugin)
const lastBoiler = boilerRows.length ? boilerRows[boilerRows.length - 1] : null;

const KPI_LABELS = STRINGS[LANG]?.kpiLabels || STRINGS['en'].kpiLabels || {};
const sc = (l,v,u='',badge='') => {
  const lbl = KPI_LABELS[l] || l;
  return `<div class="sc"><div class="sl">${lbl}</div><div class="sv">${v!==null?v+u:'<span class="na">N/A</span>'} ${badge}</div></div>`;
};
const badge = (cls,txt) => `<span class="badge badge-${cls}">${txt}</span>`;
const genAt = new Date().toLocaleString('en-GB');
const periodStart = cutoff.toLocaleDateString('en-GB');
const periodEnd = new Date().toLocaleDateString('en-GB');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Viessmann Report ${today}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/hammerjs@2.0.8/hammer.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;color:#2d2d2d}
header{background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:26px 32px}
header h1{font-size:20px;font-weight:700}
header p{font-size:12px;opacity:.65;margin-top:5px}
.wrap{max-width:1080px;margin:0 auto;padding:24px 16px}
.box{background:#fff;border-radius:12px;padding:22px 24px;margin-bottom:22px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.box h2{font-size:15px;font-weight:700;color:#1a1a2e;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #f0f0f0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:18px}
.sc{background:#f8f9fc;border-radius:8px;padding:13px 15px}
.sl{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:5px}
.sv{font-size:19px;font-weight:700;color:#1a1a2e}
.na{font-size:13px;color:#bbb;font-weight:400}
.badge{font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;vertical-align:middle}
.badge-good{background:#e6f4ea;color:#2d7a3a}
.badge-warn{background:#fff3e0;color:#e65100}
.badge-neutral{background:#eee;color:#777}
.ch{position:relative;height:210px;margin-top:6px}
.ch-tall{position:relative;height:250px;margin-top:6px}
.ch-overview{position:relative;height:320px;margin-top:6px}
.note{font-size:11px;color:#aaa;margin-top:8px;font-style:italic}
.pbars{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.pb{flex:1;min-width:90px}
.pbl{font-size:10px;color:#999;margin-bottom:4px}
.pbt{background:#f0f0f0;border-radius:3px;height:7px}
.pbf{height:7px;border-radius:3px}
.fill-normal{background:#4e9af1}
.fill-reduced{background:#f1c94e}
.fill-comfort{background:#f17c4e}
.pbp{font-size:11px;font-weight:600;margin-top:3px}
footer{text-align:center;font-size:10px;color:#bbb;padding:16px}
@media(max-width:500px){.grid{grid-template-columns:1fr 1fr}}
/* Hourly heatmap */
.hmap{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin-top:8px}
.hmap-cell{height:38px;border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;cursor:default;transition:transform .1s}
.hmap-cell:hover{transform:scale(1.15);z-index:2}
.hmap-lbl{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin-top:2px}
.hmap-lbl span{font-size:8px;color:#bbb;text-align:center}
/* Daily efficiency gauge row */
.eff-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.eff-day{background:#f8f9fc;border-radius:8px;padding:8px 10px;text-align:center;min-width:64px;flex:1}
.eff-day .eff-pct{font-size:16px;font-weight:700}
.eff-day .eff-lbl{font-size:9px;color:#aaa;margin-top:2px}
/* Energy flow legend */
.flow-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:#666}
.zoom-reset{position:absolute;top:8px;right:8px;font-size:11px;padding:3px 8px;background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;color:#555;z-index:10;}
.zoom-reset:hover{background:#f5f5f5;border-color:#aaa;}
.chart-wrap{position:relative;}
.flow-legend span::before{content:'';display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
</style>
</head>
<body>
<header>
  <h1>${T('reportTitle')}</h1>
  <p>${T('periodLabel')}: ${periodStart} — ${periodEnd} &nbsp;(${T('lastNDays',{n:DAYS})}) &nbsp;|&nbsp; ${T('generatedLabel')}: ${genAt} &nbsp;|&nbsp; ${T('samplesLabel',{n:filtered.length})}</p>
</header>
<div class="wrap">

<div class="box">
  <h2>${T('sectionOverview')}</h2>
  <div class="ch-overview"><canvas id="cOverview"></canvas></div>
  ${scheduleBarHtml}

  <p class="note">${T('leftAxisNote')}</p>
</div>

<div class="box">
  <h2>${T('sectionBoiler')}</h2>
  <!-- KPI row 1: real cycle metrics from API counter -->
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:8px">${T('cyclePerformanceTitle')}</div>
  <div class="grid" style="margin-bottom:6px">
    ${realCycleCount !== null ? sc(T('cyclesInPeriod'), realCycleCount, '', badge(effCls, effLabel)) : ''}
    ${sph ? sc('Starts/hour', sph, '/h', badge(effCls, parseFloat(sph)<2?T('badgeNormal'):parseFloat(sph)<4?T('badgeHigh'):T('badgeSevere'))) : ''}
    ${realAvgDur ? sc('Avg cycle duration', realAvgDur, ' min', badge(parseFloat(realAvgDur)<3?'bad':parseFloat(realAvgDur)<6?'warn':'good', parseFloat(realAvgDur)<3?T('badgeVeryShort'):parseFloat(realAvgDur)<6?T('badgeShort'):T('badgeOK'))) : ''}
    ${burnerRuntimePct ? sc('Burner runtime', burnerRuntimePct, '%', badge(parseFloat(burnerRuntimePct)<15?'good':parseFloat(burnerRuntimePct)<40?'warn':'bad', parseFloat(burnerRuntimePct)<15?T('badgeLowDemand'):parseFloat(burnerRuntimePct)<40?T('badgeNormal'):T('badgeHigh'))) : ''}
    ${burnerStarts ? sc(T('lifetimeStarts'), burnerStarts) : ''}
    ${burnerHours ? sc(T('lifetimeHours'), burnerHours, 'h') : ''}
  </div>
  <p class="note" style="margin-bottom:14px">${T('cycleApiNoteShort')}</p>

  <!-- KPI row 2: modulation + gas -->
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:8px">${T('modGasTitle')}</div>
  <div class="grid" style="margin-bottom:6px">
    ${sc('Avg modulation (active)', avgMod, '%', badge(parseFloat(avgMod||0)<15?'warn':'good', parseFloat(avgMod||0)<15?T('badgeLowMod'):T('badgeOK')))}
    ${sc('Max modulation', maxMod, '%')}
    ${avgHeatDemand ? sc('Avg heat demand', avgHeatDemand, ' kW') : ''}
    ${hasGasData ? sc(T('gasHeatingToday'), gasHeatingToday, ' m³') : ''}
    ${hasGasData && gasDhwToday ? sc(T('gasDhwToday'), gasDhwToday, ' m³') : ''}
    ${hasGasData && gasTotalToday ? sc(T('gasTotalToday'), gasTotalToday, ' m³') : ''}
  </div>

  ${boilerRows.length < 5 ? `<p class="note">${T('onlySamplesNote', {n: boilerRows.length})}</p>` : ''}
  ${boilerRows.length >= 2 ? `<div class="ch"><canvas id="cMod"></canvas></div><div class="ch" style="margin-top:14px"><canvas id="cBurner"></canvas></div>
  <p class="note">${T('burnerBarNote', {n: realCycleCount ?? '?', mult: realCycleCount && cycleCount ? Math.round(realCycleCount/Math.max(cycleCount,1)) : '~100'})}</p>` : ''}
  ${cycleCount >= 3 ? `<div style="margin-top:18px"><div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:10px">${T('burnerBarsTitle')}</div><div class="ch"><canvas id="cCycleHist"></canvas></div><p class="note">${T('histogramNote', {dur: realAvgDur ?? '?', vis: cycleCount, real: realCycleCount ?? '?'})}</p></div>` : ''}

  <!-- Hourly heatmap -->
  <div style="margin-top:22px">
    <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:4px">${T('heatmapTitle')}</div>
    <p class="note" style="margin-bottom:8px">${T('heatmapNote')}</p>
    <div class="hmap" id="hmapCells"></div>
    <div class="hmap-lbl">${Array.from({length:24},(_,h)=>`<span>${String(h).padStart(2,'0')}</span>`).join('')}</div>
    <div style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:10px;color:#aaa">
      <span>${T('heatmapLow')}</span>
      ${[0,20,40,60,80,100].map(v=>`<div style="width:18px;height:12px;border-radius:2px;background:${v===0?'#f0f0f0':`rgba(230,81,0,${(v/100)*0.9+0.1})`}"></div>`).join('')}
      <span>${T('heatmapHigh')}</span>
      <span style="margin-left:12px;color:#aaa">${T('heatmapBurnerPct')}</span>
    </div>
  </div>

  ${hasGasChart ? `<div style="margin-top:18px"><div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:10px">${T('gasChartTitle')}</div><div class="ch-tall"><canvas id="cGas"></canvas></div><p class="note">${T('gasChartNote')}</p></div>` : ''}

  <!-- Daily efficiency from CSV (v2.0.50+) -->
  ${dailyEfficiency.hasData ? `
  <div style="margin-top:22px">
    <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:4px">${T('effChartTitle')}</div>
    <p class="note" style="margin-bottom:8px">${T('effChartNote')}</p>
    <div class="ch"><canvas id="cDailyEff"></canvas></div>
  </div>` : ''}
</div>

<div class="box">
  <h2>${T('sectionHC0')}</h2>
  <div class="grid">
    ${sc('Avg room temp', avgRoom, '°C')}
    ${sc('Avg setpoint', avgTarget, '°C')}
    ${maxFlow ? sc('Max flow temp', maxFlow, '°C') : ''}
    ${condensingPct !== null ? sc(T('condensingMode'), condensingPct, LANG==='it'?'% del tempo':'% time', badge(condensingCls, condensingLabel)) : ''}
    ${avgFlow ? sc('Avg flow temp', avgFlow, '°C', badge(parseFloat(avgFlow||99)<45?'good':parseFloat(avgFlow||99)<55?'warn':'neutral', parseFloat(avgFlow||99)<45?T('badgeExcellent'):parseFloat(avgFlow||99)<55?T('badgeCondensing'):T('badgeHigh'))) : ''}
    ${scheduleToday ? sc(T('todayScheduleKey'), scheduleToday) : ''}
    ${condensingScore ? sc(T('csTitle'), condensingScore.pct, '%', badge(condensingScore.pct >= 90 ? 'good' : condensingScore.pct >= 60 ? 'warn' : 'bad', condensingScore.pct + (LANG==='it'?'% del tempo':'% time'))) : ''}
  </div>
  ${condensingScore ? `<p class="note" style="font-size:11px">${T('csNote')}</p>` : ''}
  ${progDist.length ? `<div style="margin-bottom:16px"><div class="sl" style="margin-bottom:8px">${T('programDistKey')}</div>
  <div class="pbars">${progDist.map(p=>`<div class="pb"><div class="pbl">${p.label}</div><div class="pbt"><div class="pbf fill-${p.cssKey||p.label.toLowerCase()}" style="width:${p.pct}%"></div></div><div class="pbp">${p.pct}%</div></div>`).join('')}</div></div>` : ''}
  ${hcRows.length >= 2 ? `<div class="ch-tall"><canvas id="cRoom"></canvas></div>` : ''}
  ${flowVals.length >= 2 ? `<div class="ch" style="margin-top:14px"><canvas id="cFlow"></canvas></div><p class="note">${T('flowTempChartNote')}</p>` : ''}
</div>

<div class="box">
  <h2>${T('sectionSystemAnalysis')}</h2>
  <div class="grid">
    ${heatDemandKW ? sc('Avg heat demand', heatDemandKW, ' kW') : ''}
    ${heatLossCoeff ? sc('Heat loss coeff.', heatLossCoeff, ' kW/°C') : ''}
    ${peakLoadKW ? sc('Est. peak load', peakLoadKW, ' kW', '<span style=\"font-size:10px;color:#888\">'+T('atOutdoorTemp',{temp:DESIGN_TEMP})+'</span>') : ''}
    ${hasBoilerKW ? sc('Boiler nominal', BOILER_KW, ' kW', boilerOversized ? badge('warn',T('badgeOversized')) : badge('good','OK')) : ''}
    ${houseEff ? sc('House efficiency', houseEff.label, '', badge(houseEff.cls, heatLossCoeff+' kW/°C')) : ''}
    ${cyclesPerHour ? sc('Starts/hour', cyclesPerHour, '/h', badge(effCls, parseFloat(cyclesPerHour)<3?T('badgeNormal'):parseFloat(cyclesPerHour)<6?T('badgeHigh'):T('badgeSevere'))) : ''}
    ${realAvgDur   ? sc('Avg cycle duration', realAvgDur, ' min', badge(parseFloat(realAvgDur)<5?'warn':parseFloat(realAvgDur)<10?'warn':'good', parseFloat(realAvgDur)<5?T('badgeShort'):parseFloat(realAvgDur)<10?T('badgeCheck'):T('badgeOK'))) : ''}
    ${cyclingScore ? sc(T('cyclingScore'), cyclingSeverity, '', badge(cyclingSeverityCls, cyclingScore)) : ''}
    ${comfortStddev ? sc('Comfort stability', comfortRating, '', badge(comfortCls, '±'+comfortStddev+'°C')) : ''}
    ${gasEfficiencyPct ? sc('Est. efficiency', gasEfficiencyPct, '%') : ''}
    ${heatCurveCorr ? sc('Heating curve', heatCurveBehaviour, '', badge(heatCurveCls, 'r='+heatCurveCorr)) : ''}
  </div>
  <div style="margin-top:16px">
    ${insights.map(i => {
      const icon = i.type==='good' ? '✅' : i.type==='warn' ? '⚠️' : 'ℹ️';
      const bg   = i.type==='good' ? '#f1f8f1' : i.type==='warn' ? '#fff8e1' : '#e8f4fd';
      const br   = i.type==='good' ? '#a5d6a7' : i.type==='warn' ? '#ffe082' : '#90caf9';
      return '<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:'+bg+';border-left:3px solid '+br+';border-radius:4px;margin-bottom:8px;font-size:13px;line-height:1.5"><span style="font-size:15px;flex-shrink:0">'+icon+'</span><span>'+i.text+'</span></div>';
    }).join('')}
  </div>
  ${recommendations.length > 0 ? `
  <div style="margin-top:20px">
    <div style="font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #f0f0f0">${T('recTitle')}</div>
    ${recommendations.map(r => {
      const bg = r.type==='warn' ? '#fff8e1' : r.type==='good' ? '#f1f8f1' : '#e8f4fd';
      const br = r.type==='warn' ? '#f57c00' : r.type==='good' ? '#43a047' : '#1e88e5';
      return '<div style="background:'+bg+';border-left:4px solid '+br+';border-radius:6px;padding:14px 16px;margin-bottom:12px">'
        + '<div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:6px">'+r.title+'</div>'
        + '<div style="font-size:12px;color:#444;margin-bottom:10px;line-height:1.5">'+r.body+'</div>'
        + '<div style="font-size:12px;font-weight:600;color:#555;margin-bottom:4px">'+T('recActionsLabel', {})+'</div>'
        + '<ul style="margin:0 0 10px 0;padding-left:18px;font-size:12px;color:#444;line-height:1.7">'
        + r.actions.map(a => '<li>'+a+'</li>').join('')
        + '</ul>'
        + '<div style="font-size:11px;color:#888;border-top:1px solid rgba(0,0,0,.06);padding-top:6px">'
        + '<strong>'+T('recImpact')+':</strong> '+r.impact+'</div>'
        + '</div>';
    }).join('')}
  </div>` : ''}
  ${scatterData.length >= 10 ? `
  <div style="margin-top:18px">
    <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:6px">${T('heatDemandSTitle')}</div>
    <div class="chart-wrap"><div class="ch-tall"><canvas id="cScatter"></canvas></div><button class="zoom-reset" onclick="resetZoom('cScatter')">${T('zoomReset')}</button></div>
    <p class="note">${T('heatDemandNote1')}${scatterRegression?.balancePoint ? ' '+T('balancePoint',{bp:scatterRegression.balancePoint}) : ''}${heatLossLine ? ' '+T('hlLineLabelShort',{h:heatLossCoeff}) : ''} ${T('scrollZoomNote')}</p>
  </div>` : ''}
  ${hasCurve && corrPairs2.length >= 5 ? `
  <div style="margin-top:18px">
    <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-bottom:6px">${T('flowCurveSTitle')}</div>
    <div class="chart-wrap"><div class="ch-tall"><canvas id="cFlowCurve"></canvas></div><button class="zoom-reset" onclick="resetZoom('cFlowCurve')">${T('zoomReset')}</button></div>
    <p class="note">${T('flowCurveNote', {slope: CURVE_SLOPE, shift: CURVE_SHIFT})}</p>
  </div>` : ''}
</div>

<div class="box">
  <h2>${T('ceTitle')}</h2>
  ${comfortEfficiency.available ? `
  <div class="grid" style="margin-bottom:16px">
    ${sc(T('ceStabilityLabel'), '±'+comfortEfficiency.avgStability, '°C')}
    ${sc(T('ceGasNormLabel'), comfortEfficiency.avgGasNorm, ' m³/°C·h')}
    ${sc(T('ceTrendStability'), Math.abs(parseFloat(comfortEfficiency.dStability)) < 5 ? T('ceUnchanged') : parseFloat(comfortEfficiency.dStability) > 0 ? T('ceImproved')+' '+Math.abs(comfortEfficiency.dStability)+'%' : T('ceWorsened')+' '+Math.abs(comfortEfficiency.dStability)+'%', '', badge(parseFloat(comfortEfficiency.dStability) > 5 ? 'good' : parseFloat(comfortEfficiency.dStability) < -5 ? 'bad' : 'neutral', ''))}
    ${sc(T('ceTrendGas'), Math.abs(parseFloat(comfortEfficiency.dGas)) < 5 ? T('ceUnchanged') : parseFloat(comfortEfficiency.dGas) < 0 ? T('ceImproved')+' '+Math.abs(comfortEfficiency.dGas)+'%' : T('ceWorsened')+' '+Math.abs(comfortEfficiency.dGas)+'%', '', badge(parseFloat(comfortEfficiency.dGas) < -5 ? 'good' : parseFloat(comfortEfficiency.dGas) > 5 ? 'warn' : 'neutral', ''))}
  </div>
  ${(() => {
    const ins = comfortEfficiency.insight;
    if (!ins) return '';
    const icon = ins.type==='good' ? '✅' : ins.type==='warn' ? '⚠️' : 'ℹ️';
    const bg   = ins.type==='good' ? '#f1f8f1' : ins.type==='warn' ? '#fff8e1' : '#e8f4fd';
    const br   = ins.type==='good' ? '#a5d6a7' : ins.type==='warn' ? '#ffe082' : '#90caf9';
    return '<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:'+bg+';border-left:3px solid '+br+';border-radius:4px;font-size:13px;line-height:1.5"><span style="font-size:15px;flex-shrink:0">'+icon+'</span><span>'+T(ins.key)+'</span></div>';
  })()}` : `
  <div style="padding:18px 16px;background:#f8f9fa;border-radius:8px;border:1px dashed #ddd;text-align:center;color:#888;font-size:13px">
    <div style="font-size:24px;margin-bottom:8px">📊</div>
    <div>${T('ceNotEnoughData', {need: comfortEfficiency.daysNeed, have: comfortEfficiency.daysHave})}</div>
  </div>`}
</div>

<div class="box">
  <h2>${T('sectionDHW')}</h2>
  <div class="grid">
    ${sc('Avg temp', avgDhw, '°C')}
    ${sc('Avg setpoint', avgDhwTarget, '°C')}
  </div>
  ${dhwRows.length >= 2 ? `<div class="ch-tall"><canvas id="cDhw"></canvas></div>` : ''}
</div>

${apiSummary ? `
<div class="box">
  <h2>${T('sectionEnergySummary')}</h2>
  <p class="note" style="margin-bottom:14px">${T('energySummaryNote', {ts: apiSummary.timestamp ? new Date(apiSummary.timestamp).toLocaleString('en-GB') : 'N/A'})}</p>

  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:8px">${T('gasSectionHeating')}</div>
  <div class="grid" style="margin-bottom:16px">
    ${apiSummary.gasHeat7d   !== null ? sc(T('heatingLastNDays',{n:7}), apiSummary.gasHeat7d,   ' m³') : ''}
    ${apiSummary.gasHeatMonth !== null ? sc(T('heatingThisMonth'),  apiSummary.gasHeatMonth,' m³') : ''}
    ${apiSummary.gasHeatYear  !== null ? sc(T('heatingThisYear'),   apiSummary.gasHeatYear, ' m³') : ''}
    ${apiSummary.gasDhwMonth  !== null ? sc(T('dhwThisMonth'),      apiSummary.gasDhwMonth, ' m³') : ''}
    ${apiSummary.gasDhwYear   !== null ? sc(T('dhwThisYear'),       apiSummary.gasDhwYear,  ' m³') : ''}
    ${(apiSummary.gasHeatMonth !== null && apiSummary.gasDhwMonth !== null) ? sc(T('totalThisMonth'), +(apiSummary.gasHeatMonth + apiSummary.gasDhwMonth).toFixed(1), ' m³') : ''}
    ${(apiSummary.gasHeatYear  !== null && apiSummary.gasDhwYear  !== null) ? sc(T('totalThisYear'),  +(apiSummary.gasHeatYear  + apiSummary.gasDhwYear).toFixed(1),  ' m³') : ''}
  </div>

  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:8px">${T('heatSectionTitle')}</div>
  <div class="grid" style="margin-bottom:16px">
    ${apiSummary.heatProdHeatMonth !== null ? sc('Heating this month', apiSummary.heatProdHeatMonth, ' kWh') : ''}
    ${apiSummary.heatProdHeatYear  !== null ? sc('Heating this year',  apiSummary.heatProdHeatYear,  ' kWh') : ''}
    ${apiSummary.heatProdDhwMonth  !== null ? sc('DHW this month',     apiSummary.heatProdDhwMonth,  ' kWh') : ''}
    ${apiSummary.heatProdDhwYear   !== null ? sc('DHW this year',      apiSummary.heatProdDhwYear,   ' kWh') : ''}
    ${apiSummary.pwrConsHeatMonth  !== null ? sc(T('pumpPowerMonth'),   apiSummary.pwrConsHeatMonth,  ' kWh') : ''}
    ${apiSummary.pwrConsHeatYear   !== null ? sc(T('pumpPowerYear'),    apiSummary.pwrConsHeatYear,   ' kWh') : ''}
  </div>

  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:8px">${T('thermalEffTitle')}</div>
  <div class="grid">
    ${apiSummary.thermalEffMonth !== undefined ? sc(T('effThisMonth'), apiSummary.thermalEffMonth, '%', badge(apiSummary.thermalEffMonth >= 90 ? 'good' : 'warn', apiSummary.thermalEffMonth >= 90 ? T('badgeCondensing') : T('badgeCheck'))) : ''}
    ${apiSummary.thermalEffYear  !== undefined ? sc(T('effThisYear'),  apiSummary.thermalEffYear,  '%', badge(apiSummary.thermalEffYear  >= 90 ? 'good' : 'warn', apiSummary.thermalEffYear  >= 90 ? T('badgeCondensing') : T('badgeCheck'))) : ''}
    ${apiSummary.burnerLifeStarts !== null ? sc('Lifetime starts', apiSummary.burnerLifeStarts) : ''}
    ${apiSummary.burnerLifeHours  !== null ? sc('Lifetime hours',  apiSummary.burnerLifeHours, 'h') : ''}
  </div>
  <p class="note" style="margin-top:10px">${T('thermalEffNote')}</p>
</div>` : ''}

${gasForecast ? `
<div class="box">
  <h2>${T('sectionGasForecast')}</h2>
  <p class="note" style="margin-bottom:14px">${T('forecastProjectionNote', {n: gasForecast.daysUsed, price: gasForecast.gasPrice, trend: gasForecast.trend === 'rising' ? T('forecastTrendRising') : gasForecast.trend === 'falling' ? T('forecastTrendFalling') : T('forecastTrendStable')})}</p>
  <div class="grid">
    ${sc(T('avgConsPerDay'), gasForecast.avgPerDay, ' m³')}
    ${sc(T('projNext30'), gasForecast.month30, ' m³', badge(gasForecast.trend === 'rising' ? 'warn' : 'good', '≈ €' + gasForecast.costMonth))}
    ${gasForecast.hasEnoughForAnnual
      ? sc(T('annualEstLabel'), gasForecast.annualEst, ' m³', badge('neutral', '≈ €' + gasForecast.costAnnual))
      : sc(T('annualEstLabel'), 'N/A', '', badge('neutral', T('needDaysShort',{min:gasForecast.annualMinDays,n:gasForecast.daysUsed})))}
  </div>
  <p class="note" style="margin-top:10px">ℹ️ ${gasForecast.hasEnoughForAnnual
    ? 'Annual estimate uses period average × 365 — seasonal variations not accounted for.'
    : T('forecastNote', {min: gasForecast.annualMinDays, n: gasForecast.daysUsed})}</p>
</div>` : ''}

${energyRows.length >= 1 ? `
<div class="box">
  <h2>${T('sectionEnergySystem')}</h2>
  <div class="grid">
    ${hasPV ? sc('PV avg production', avgPV, 'W') : ''}
    ${hasPV ? sc('PV max production', maxPV, 'W') : ''}
    ${hasPV ? sc('PV yield (latest day)', lastPvDaily, 'kWh') : ''}
    ${hasBattery ? sc('Battery level (latest)', lastBattLevel, '%') : ''}
    ${hasWallbox ? sc('Wallbox avg power', avgWallboxPwr, 'W') : ''}
  </div>
  ${energyRows.length < 5 ? `<p class="note">${T('onlySamplesNote', {n: energyRows.length})}</p>` : ''}
  ${energyFlow?.hasData ? `
  <div style="margin-top:6px">
    <div style="font-size:12px;font-weight:700;color:#1a1a2e;margin-bottom:6px">⚡ Daily average power flow (W)</div>
    <div class="ch-tall"><canvas id="cEnergyFlow"></canvas></div>
    <div class="flow-legend">
      <span style="--c:#f9a825">☀️ PV production</span>
      <span style="--c:#43a047">🔋 Battery charging</span>
      <span style="--c:#e53935">🔋 Battery discharging</span>
      <span style="--c:#1e88e5">🔌 Grid draw</span>
      <span style="--c:#7b1fa2">🚗 Wallbox</span>
    </div>
    <p class="note">Daily averages of instantaneous W readings from CSV snapshots (15-min resolution).</p>
  </div>` : ''}
  ${hasPV && energyRows.length >= 2 ? `<div class="ch-tall" style="margin-top:14px"><canvas id="cPV"></canvas></div>` : ''}
  ${hasBattery && energyRows.length >= 2 ? `<div class="ch-tall" style="margin-top:14px"><canvas id="cBatt"></canvas></div>` : ''}
  ${hasWallbox && energyRows.length >= 2 ? `<div class="ch" style="margin-top:14px"><canvas id="cWallbox"></canvas></div>` : ''}
</div>` : ''}

<div class="box" id="device-messages">
  <h2>${T('sectionDeviceMessages')}</h2>
  <p class="note" style="margin-bottom:12px">${T('deviceMessagesNote')}</p>
  <div id="msg-list">
${(() => {
  // Read messages from viessmann-messages-<installationId>-<deviceId>.json files.
  // Multiple files exist when an installation has multiple devices (e.g. Vitocal + VitoCharge).
  // Aggregate all matching files and merge, sorted newest-first.
  const _fs = require('fs');
  const _path = require('path');
  let messages = [];
  try {
    const pattern = INSTALLATION_ID
      ? `viessmann-messages-${INSTALLATION_ID}-`
      : 'viessmann-messages-';
    const allFiles = _fs.readdirSync(HB_PATH)
      .filter(f => f.startsWith(pattern) && f.endsWith('.json'));
    for (const fname of allFiles) {
      try {
        const entries = JSON.parse(_fs.readFileSync(_path.join(HB_PATH, fname), 'utf8'));
        messages.push(...entries);
      } catch(_) {}
    }
    // Sort merged messages newest-first
    messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch(_) {}

  if (!messages.length) {
    return `<p class="note">${T('deviceMessagesNoFile')} <code>viessmann-messages-${INSTALLATION_ID || 'ID'}-DEVICEID.json</code> ${T('oneFilePerDevice')}</p>`;
  }

  return messages.slice(0, 20).map(m => {
    const code = m.errorCode || m.code || '';
    const desc = translateCode(code);
    const ts = m.timestamp ? new Date(m.timestamp).toLocaleString('en-GB') : '';
    const type = code.startsWith('F.') ? 'fault' : code.startsWith('I.') ? 'info' : 'status';
    const bg   = type === 'fault' ? '#fff3e0' : type === 'info' ? '#e8f4fd' : '#f1f8f1';
    const br   = type === 'fault' ? '#ffb74d' : type === 'info' ? '#90caf9' : '#a5d6a7';
    const icon = type === 'fault' ? '⚠️' : type === 'info' ? 'ℹ️' : '✅';
    return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;background:${bg};border-left:3px solid ${br};border-radius:4px;margin-bottom:6px;font-size:13px">
      <span style="flex-shrink:0">${icon}</span>
      <div style="flex:1">
        <strong>${code}</strong>${desc ? ` — ${desc}` : ' — (unknown code)'}
        ${ts ? `<span style="color:#888;font-size:11px;margin-left:8px">${ts}</span>` : ''}
        ${m.busAddress ? `<span style="color:#aaa;font-size:11px;margin-left:8px">bus: ${m.busAddress}</span>` : ''}
      </div>
    </div>`;
  }).join('');
})()}
  </div>
</div>

</div>
<footer>homebridge-viessmann-vicare &nbsp;|&nbsp; ${CSV_FILE}</footer>

<script>
Chart.defaults.font.family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
Chart.defaults.font.size=11;Chart.defaults.color='#888';

// Hide all reset zoom buttons initially
document.querySelectorAll('.zoom-reset').forEach(b=>b.style.display='none');

// Global reset zoom helper
function resetZoom(canvasId){
  const c=document.getElementById(canvasId);
  if(!c)return;
  const ch=Chart.getChart(c);
  if(ch){ch.resetZoom();c.closest('.chart-wrap')?.querySelector('.zoom-reset')?.style.setProperty('display','none');}
}

function mk(id,labels,datasets,yLbl){
  const c=document.getElementById(id); if(!c)return;
  new Chart(c,{type:'line',data:{labels,datasets},options:{
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{position:'top',labels:{boxWidth:11,padding:14}}},
    scales:{
      x:{ticks:{maxTicksLimit:8,maxRotation:30},grid:{color:'#f5f5f5'}},
      y:{title:{display:!!yLbl,text:yLbl},grid:{color:'#f5f5f5'}}
    }
  }});
}

// i18n strings injected at build time for browser use
const _tooltip={
  outdoor:${JSON.stringify(T('tooltipOutdoor',{x:'__X__',y:'__Y__'}))},
  flowActual:${JSON.stringify(T('tooltipFlowActual',{x:'__X__',y:'__Y__'}))},
  flowCurve:${JSON.stringify(T('tooltipFlowCurve',{x:'__X__',y:'__Y__'}))},
};
function _tt(tpl,x,y){return tpl.replace('__X__',x).replace('__Y__',y);}

// Overview chart — dual Y axis
(function(){
  const c=document.getElementById('cOverview'); if(!c)return;
  new Chart(c,{type:'line',data:{
    labels:${JSON.stringify(ovLabels)},
    datasets:[
      {label:"${T('chartRoomTemp')}", yAxisID:'yTemp', data:${JSON.stringify(ovRoom)},    borderColor:'#4e9af1',backgroundColor:'rgba(78,154,241,.06)',fill:true, tension:0.3,pointRadius:1,borderWidth:2},
      {label:"${T('chartHC0Setpoint')}",   yAxisID:'yTemp', data:${JSON.stringify(ovSetpoint)},borderColor:'#f1c94e',backgroundColor:'transparent',             fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[5,4]},
      ...(${JSON.stringify(ovFlow)}.some(v=>v!==null) ? [{label:"${T('chartFlowTemp')}", yAxisID:'yTemp', data:${JSON.stringify(ovFlow)}, borderColor:'#ef5350',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[2,2]}] : []),
      {label:"${T('chartDHWTemp')}",      yAxisID:'yTemp', data:${JSON.stringify(ovDhw)},     borderColor:'#00897b',backgroundColor:'rgba(0,137,123,.04)',fill:false,tension:0.3,pointRadius:1,borderWidth:1.5},
      {label:"${T('chartOutdoorTemp')}",  yAxisID:'yTemp', data:${JSON.stringify(ovOutside)}, borderColor:'#90a4ae',backgroundColor:'transparent',             fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[3,3]},
      {label:"${T('chartModulation')}",     yAxisID:'yRight',data:${JSON.stringify(ovMod)},     borderColor:'#e65100',backgroundColor:'rgba(230,81,0,.04)',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5},
      {label:"${T('chartBurnerBar')}",  yAxisID:'yRight',data:${JSON.stringify(ovBurner)},  borderColor:'#37474f',backgroundColor:'rgba(55,71,79,.07)', fill:true, tension:0,  pointRadius:0,borderWidth:1,stepped:true},
      ...(${JSON.stringify(ovOutsideHum)}.some(v=>v!==null) ? [{label:"${T('chartOutdoorHum')}", yAxisID:'yRight',data:${JSON.stringify(ovOutsideHum)},borderColor:'#7986cb',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[4,2]}] : [])
    ]
  },options:{
    responsive:true,maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{position:'top',labels:{boxWidth:11,padding:12,usePointStyle:true}}},
    scales:{
      x:{ticks:{maxTicksLimit:10,maxRotation:30},grid:{color:'#f5f5f5'}},
      yTemp:{type:'linear',position:'left', title:{display:true,text:'°C'},grid:{color:'#f5f5f5'},ticks:{color:'#4e9af1'}},
      yRight:{type:'linear',position:'right',title:{display:true,text:'% / ON–OFF'},grid:{drawOnChartArea:false},min:0,max:110,ticks:{color:'#e65100'}}
    }
    }});

})();
${boilerRows.length>=2?`
mk('cMod',${JSON.stringify(modChart.labels)},[{label:"${T('chartModulation')}",data:${JSON.stringify(modChart.values)},borderColor:'#e65100',backgroundColor:'rgba(230,81,0,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'%');
mk('cBurner',${JSON.stringify(burnerChart.labels)},[{label:"${T('chartBurnerOnOff')}",data:${JSON.stringify(burnerChart.values)},borderColor:'#1a1a2e',backgroundColor:'rgba(26,26,46,.06)',fill:true,tension:0,pointRadius:0,borderWidth:1.5,stepped:true}],'');`:''}
${hcRows.length>=2?`
mk('cRoom',${JSON.stringify(roomChart.labels)},[
  {label:"${T('chartRoomTemp')}",data:${JSON.stringify(roomChart.values)},borderColor:'#4e9af1',backgroundColor:'rgba(78,154,241,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2},
  {label:"${T('chartSetpoint')}",data:${JSON.stringify(targetChart.values)},borderColor:'#f1c94e',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:2,borderDash:[5,4]}
],'°C');`:''}
${flowVals.length>=2?`
mk('cFlow',${JSON.stringify(flowChart.labels)},[{label:"${T('chartFlowTemp')}",data:${JSON.stringify(flowChart.values)},borderColor:'#ef5350',backgroundColor:'rgba(239,83,80,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'°C');
`:''}
${cycleCount>=3?`
(function(){const c=document.getElementById('cCycleHist');if(!c)return;new Chart(c,{type:'bar',data:{labels:${JSON.stringify(histBuckets.map(b=>b.label))},datasets:[{label:"${T('chartCycles')}",data:${JSON.stringify(histData)},backgroundColor:${JSON.stringify(histData.map((_,i)=>i===0?'rgba(239,83,80,.7)':'rgba(78,154,241,.6)'))},borderColor:${JSON.stringify(histData.map((_,i)=>i===0?'#ef5350':'#4e9af1'))},borderWidth:1.5,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:'#f5f5f5'}},y:{title:{display:true,text:"${T('axisCycles')}"},ticks:{stepSize:1}}}}});})();
`:''}
${hasGasChart?`
(function(){
  const c=document.getElementById('cGas'); if(!c)return;
  new Chart(c,{
    type:'bar',
    data:{
      labels:${JSON.stringify(gasBarLabels)},
      datasets:[
        {type:'bar', label:"${T('chartHeatingM3')}", data:${JSON.stringify(gasBarHeating)}, backgroundColor:'rgba(26,86,180,.75)', borderColor:'#1a56b4', borderWidth:1, borderRadius:3, stack:'gas'},
        {type:'bar', label:"${T('chartDHWM3')}",     data:${JSON.stringify(gasBarDhw)},     backgroundColor:'rgba(0,137,123,.65)', borderColor:'#00897b', borderWidth:1, borderRadius:3, stack:'gas'},
        {type:'line',label:"${T('chartTotalM3')}",   data:${JSON.stringify(gasLineTotal)},  borderColor:'#e53935', backgroundColor:'transparent', borderWidth:2, pointRadius:4, pointBackgroundColor:'#e53935', tension:0.3, yAxisID:'y'}
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'top',labels:{boxWidth:11,padding:12}}},
      scales:{
        x:{grid:{color:'#f5f5f5'},stacked:true},
        y:{title:{display:true,text:'m\u00b3'},grid:{color:'#f5f5f5'},stacked:true,beginAtZero:true}
      }
    }
  });
})();
`:''}
${dhwRows.length>=2?`
mk('cDhw',${JSON.stringify(dhwChart.labels)},[
  {label:"${T('chartDHWTemp')}",data:${JSON.stringify(dhwChart.values)},borderColor:'#00897b',backgroundColor:'rgba(0,137,123,.07)',fill:true,tension:0.3,pointRadius:2,borderWidth:2},
  {label:"${T('chartDHWSetpoint')}",data:${JSON.stringify(dhwTgtChart.values)},borderColor:'#80cbc4',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:2,borderDash:[5,4]}
],'°C');`:''}
${hasPV&&energyRows.length>=2?`
mk('cPV',${JSON.stringify(pvChart.labels)},[{label:"${T('chartPVProd')}",data:${JSON.stringify(pvChart.values)},borderColor:'#f9a825',backgroundColor:'rgba(249,168,37,.1)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'W');`:''}\n${hasBattery&&energyRows.length>=2?`
mk('cBatt',${JSON.stringify(battChart.labels)},[{label:"${T('chartBattLevel')}",data:${JSON.stringify(battChart.values)},borderColor:'#43a047',backgroundColor:'rgba(67,160,71,.08)',fill:true,tension:0.3,pointRadius:2,borderWidth:2},{label:"${T('chartBattChargeW')}",data:${JSON.stringify(battChrChart.values)},borderColor:'#1e88e5',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[4,3]},{label:"${T('chartBattDischarge')}",data:${JSON.stringify(battDisChart.values)},borderColor:'#e53935',backgroundColor:'transparent',fill:false,tension:0.3,pointRadius:0,borderWidth:1.5,borderDash:[4,3]}],'');`:''}\n${hasWallbox&&energyRows.length>=2?`
mk('cWallbox',${JSON.stringify(wallboxChart.labels)},[{label:"${T('chartWallboxW')}",data:${JSON.stringify(wallboxChart.values)},borderColor:'#7b1fa2',backgroundColor:'rgba(123,31,162,.08)',fill:true,tension:0.3,pointRadius:2,borderWidth:2}],'W');`:''}\n${scatterData.length>=10?`
(function(){
  const c=document.getElementById('cScatter'); if(!c)return;
  const pts=${JSON.stringify(scatterData.length > 300 ? scatterData.filter((_,i)=>i%Math.ceil(scatterData.length/300)===0) : scatterData)};
  const reg=${JSON.stringify(scatterRegression)};
  const datasets=[{
    label:"${T('chartHeatDemand')}",
    data:pts,
    backgroundColor:'rgba(78,154,241,0.35)',
    pointRadius:3,
    pointHoverRadius:5,
    type:'scatter'
  }];
  if(reg){
    datasets.push({
      label:"${T('chartTrend')}",
      data:reg.line,
      type:'line',
      borderColor:'#ef5350',
      backgroundColor:'transparent',
      borderWidth:2,
      pointRadius:0,
      tension:0
    });
  }
  const hlLine=${JSON.stringify(heatLossLine)};
  if(hlLine){
    datasets.push({
      label:${JSON.stringify(heatLossLine ? T('chartHeatLossLine',{h:heatLossCoeff}) : '')},
      data:hlLine,
      type:'line',
      borderColor:'rgba(67,160,71,0.85)',
      backgroundColor:'transparent',
      borderWidth:2,
      borderDash:[5,3],
      pointRadius:0,
      tension:0
    });
  }
  new Chart(c,{
    type:'scatter',
    data:{datasets},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      plugins:{
        legend:{display:true,position:'top'},
        tooltip:{callbacks:{label:p=>_tt(_tooltip.outdoor,p.parsed.x,p.parsed.y)}}
      },
      scales:{
        x:{title:{display:true,text:"${T('axisOutdoorTemp')}"},grid:{color:'#f5f5f5'}},
        y:{title:{display:true,text:"${T('axisHeatDemand')}"},beginAtZero:true,grid:{color:'#f5f5f5'}}
      },
      plugins:{
        zoom:{
          zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'xy',
               onZoomComplete:({chart})=>{chart.canvas.closest('.chart-wrap')?.querySelector('.zoom-reset')?.style.setProperty('display','block')}},
          pan:{enabled:true,mode:'xy'},
          limits:{x:{min:'original',max:'original'},y:{min:'original',max:'original'}}
        }
      }
    }
  });
  c.addEventListener('dblclick',()=>Chart.getChart(c)?.resetZoom());
})();
`:``}
${hasCurve && corrPairs2.length >= 5 ? `
// ── Flow temp vs outdoor + heating curve ───────────────────────────────
(function(){
  const c=document.getElementById('cFlowCurve'); if(!c)return;
  // Real data points: x=outdoor, y=flow_temp (burner-active samples)
  const pts=${JSON.stringify(
    (() => {
      const raw = corrPairs2.length > 400
        ? corrPairs2.filter((_,i) => i % Math.ceil(corrPairs2.length/400) === 0)
        : corrPairs2;
      return raw.map(p => ({ x: p[0], y: p[1] }));
    })()
  )};
  const curve=${JSON.stringify(heatingCurveLine)};
  new Chart(c,{
    type:'scatter',
    data:{datasets:[
      {
        label:"${T('chartActualFlow')}",
        data:pts,
        backgroundColor:'rgba(78,154,241,0.4)',
        pointRadius:3,
        pointHoverRadius:5,
        type:'scatter'
      },
      {
        label:"${T('chartHeatingCurve',{slope:CURVE_SLOPE,shift:CURVE_SHIFT})}",
        data:curve,
        type:'line',
        borderColor:'#f57c00',
        backgroundColor:'transparent',
        borderWidth:2.5,
        borderDash:[7,4],
        pointRadius:0,
        tension:0
      },
      {
        label:"${T('chartCondensingLimit')}",
        data:[{x:-30,y:55},{x:30,y:55}],
        type:'line',
        borderColor:'rgba(67,160,71,0.7)',
        backgroundColor:'rgba(67,160,71,0.07)',
        borderWidth:1.5,
        borderDash:[4,3],
        pointRadius:0,
        tension:0,
        fill:'+1'
      }
    ]},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:true,position:'top',labels:{boxWidth:11,padding:12}},
        tooltip:{callbacks:{label:p=>p.dataset.type==='scatter'
          ? _tt(_tooltip.flowActual,p.parsed.x,p.parsed.y)
          : _tt(_tooltip.flowCurve,p.parsed.x,p.parsed.y)}}
      },
      scales:{
        x:{title:{display:true,text:"${T('axisOutdoorTemp')}"},grid:{color:'#f5f5f5'}},
        y:{title:{display:true,text:"${T('axisFlowTemp')}"},grid:{color:'#f5f5f5'},suggestedMin:20,suggestedMax:80}
      },
      plugins:{
        zoom:{
          zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'xy',
               onZoomComplete:({chart})=>{chart.canvas.closest('.chart-wrap')?.querySelector('.zoom-reset')?.style.setProperty('display','block')}},
          pan:{enabled:true,mode:'xy'},
          limits:{x:{min:'original',max:'original'},y:{min:'original',max:'original'}}
        }
      }
    }
  });
  c.addEventListener('dblclick',()=>Chart.getChart(c)?.resetZoom());
})();
` : ''}

// ── Hourly heatmap ──────────────────────────────────────────────────────
(function(){
  const data=${JSON.stringify(hourlyStats)};
  const container=document.getElementById('hmapCells');
  if(!container)return;
  data.forEach(h=>{
    const pct=h.runtimePct;
    const alpha=pct===0?0:Math.max(0.08,pct/100*0.85+0.08);
    const bg=pct===0?'#f0f0f0':'rgba(230,81,0,'+alpha.toFixed(2)+')';
    const fg=pct>50?'#fff':'#444';
    const cell=document.createElement('div');
    cell.className='hmap-cell';
    cell.style.background=bg;
    cell.style.color=fg;
    const outsideTxt=h.avgOutside!==null?'  |  outdoor '+h.avgOutside+'\u00b0C':'';
    cell.title=h.label+': burner ON '+pct+'%'+outsideTxt;
    cell.innerHTML=pct>0?'<span>'+pct+'%</span>':'<span style="opacity:.3">\u2014</span>';
    container.appendChild(cell);
  });
})();

${dailyEfficiency.hasData?`
// ── Daily thermal efficiency chart ─────────────────────────────────────
(function(){
  const c=document.getElementById('cDailyEff');if(!c)return;
  const vals=${JSON.stringify(dailyEfficiency.values)};
  new Chart(c,{
    type:'line',
    data:{
      labels:${JSON.stringify(dailyEfficiency.labels)},
      datasets:[{
        label:"${T('chartThermalEff')}",
        data:vals,
        borderColor:'#43a047',
        backgroundColor:'rgba(67,160,71,.09)',
        fill:true,tension:0.3,pointRadius:5,borderWidth:2,
        pointBackgroundColor:vals.map(v=>v>=95?'#2d7a3a':v>=85?'#f57c00':'#e53935'),
        pointBorderColor:'#fff',pointBorderWidth:1.5
      }]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:ctx=>ctx.parsed.y+'% \u2014 '+(ctx.parsed.y>=95?'Condensing \u2713':ctx.parsed.y>=85?'OK':'Check')}}
      },
      scales:{
        x:{grid:{color:'#f5f5f5'}},
        y:{title:{display:true,text:'%'},suggestedMin:70,suggestedMax:105,grid:{color:'#f5f5f5'},ticks:{callback:v=>v+'%'}}
      }
    }
  });
})();
`:''}

${energyFlow&&energyFlow.hasData?`
// ── Energy flow chart ───────────────────────────────────────────────────
(function(){
  const c=document.getElementById('cEnergyFlow');if(!c)return;
  const ef=${JSON.stringify(energyFlow)};
  const ds=[
    {label:"${T('chartPV')}",             data:ef.pv,      backgroundColor:'rgba(249,168,37,.75)',borderColor:'#f9a825',borderWidth:1,borderRadius:2,stack:'s'},
    {label:"${T('chartBattCharge')}", data:ef.battChr, backgroundColor:'rgba(67,160,71,.65)', borderColor:'#43a047',borderWidth:1,borderRadius:2,stack:'s'},
    {label:"${T('chartGridDraw')}",       data:ef.gridDraw,backgroundColor:'rgba(30,136,229,.65)',borderColor:'#1e88e5',borderWidth:1,borderRadius:2,stack:'s'},
  ];
  if(ef.wallbox.some(v=>v>0))ds.push({label:"${T('chartWallbox')}",data:ef.wallbox,backgroundColor:'rgba(123,31,162,.55)',borderColor:'#7b1fa2',borderWidth:1,borderRadius:2,stack:'s'});
  new Chart(c,{
    type:'bar',
    data:{labels:ef.labels,datasets:ds},
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'top',labels:{boxWidth:11,padding:12}}},
      scales:{
        x:{grid:{color:'#f5f5f5'},stacked:true},
        y:{title:{display:true,text:"${T('axisAvgW')}"},grid:{color:'#f5f5f5'},stacked:true,beginAtZero:true}
      }
    }
  });
})();
`:''}

<\/script>
</body></html>`;

fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log(`Report generated: ${OUT_FILE}`);
console.log(`Open in browser: file://${OUT_FILE}`);
