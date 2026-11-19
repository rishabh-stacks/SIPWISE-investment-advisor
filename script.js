// SIPWise: SIP goal planner

const byId = id => document.getElementById(id);
const isDark = () => document.body.classList.contains('dark');

const form = byId('planForm');
const charts = {};
let latest = null; // result of the last render, the chart tooltips read from it

const fundTypes = [
  { name: 'Debt fund', rate: 7 },
  { name: 'Hybrid fund', rate: 10 },
  { name: 'Equity fund', rate: 12 }
];

const requiredDocs = ['PAN card', 'Aadhaar (KYC)', 'Bank account proof', 'Passport photo', 'Nominee details'];


/* helpers */

function formatRupees(amount) {
  return '₹' + Math.round(amount).toLocaleString('en-IN');
}

// short labels for the chart axis, e.g. 2500000 becomes "25 L"
function shortAmount(value) {
  if (value >= 10000000) return Number((value / 10000000).toFixed(1)) + ' Cr';
  if (value >= 100000) return Number((value / 100000).toFixed(1)) + ' L';
  return value.toLocaleString('en-IN');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function loadFromStorage(key, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return saved === null ? fallback : saved;
  } catch (error) {
    return fallback;
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // storage can be blocked (private mode), the app still works without it
  }
}


/* calculations */

// Future value of a monthly SIP, paid at the start of each month:
// FV = P * ((1 + i)^n - 1) / i * (1 + i)
// P = monthly SIP, i = annual rate / 1200, n = number of months
function futureValue(monthlySip, annualRate, years) {
  const months = years * 12;
  const monthlyRate = annualRate / 1200;

  if (monthlyRate === 0) return monthlySip * months;
  return monthlySip * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate) * (1 + monthlyRate);
}

// Same formula solved for P: the monthly SIP needed to reach a goal
function requiredSip(goal, annualRate, years) {
  const months = years * 12;
  const monthlyRate = annualRate / 1200;

  if (months === 0) return 0;
  if (monthlyRate === 0) return goal / months;
  return (goal * monthlyRate) / ((Math.pow(1 + monthlyRate, months) - 1) * (1 + monthlyRate));
}

// Readiness score = rules passed / 4 * 100
function evaluate(d) {
  const corpus = futureValue(d.sip, d.rate, d.years);

  const rules = [
    {
      name: 'Saving rate',
      check: 'SIP is at least 10% of income',
      pass: d.income > 0 && d.sip >= 0.1 * d.income,
      tip: d.income > 0
        ? `Raise your SIP to at least ${formatRupees(0.1 * d.income)}, which is 10% of your income.`
        : 'Enter your monthly income so we can check your saving rate.'
    },
    {
      name: 'Emergency fund',
      check: 'Fund covers 6 months of expenses',
      pass: d.expenses > 0 && d.fund >= 6 * d.expenses,
      tip: d.expenses > 0
        ? `Build an emergency fund of ${formatRupees(6 * d.expenses)} (6 months of expenses) before investing more.`
        : 'Enter your monthly expenses so we can check your emergency fund.'
    },
    {
      name: 'Time horizon',
      check: 'Invest for 5 years or more',
      pass: d.years >= 5,
      tip: 'Invest for at least 5 years. Short periods make market returns unpredictable.'
    },
    {
      name: 'Goal reachable',
      check: 'Projected value meets your goal',
      pass: d.goal > 0 && corpus >= d.goal,
      tip: d.goal > 0
        ? `Increase your SIP to about ${formatRupees(requiredSip(d.goal, d.rate, d.years))} a month, or extend the duration, to reach your goal.`
        : 'Enter a goal amount to see if your plan can reach it.'
    }
  ];

  const pct = rules.filter(rule => rule.pass).length * 25;
  let verdict, level, risk;

  if (pct === 100) {
    verdict = 'Ready';
    level = 'ok';
    risk = 'Low';
  } else if (pct >= 50) {
    verdict = 'Partly ready';
    level = 'warn';
    risk = 'Medium';
  } else {
    verdict = 'Not ready';
    level = 'bad';
    risk = 'High';
  }

  return { corpus, invested: d.sip * d.years * 12, rules, pct, verdict, level, risk };
}


/* reading the form */

function readNumber(id) {
  return Math.max(0, parseFloat(byId(id).value) || 0);
}

function readForm() {
  return {
    name: byId('name').value.trim(),
    goalType: byId('goalType').value,
    income: readNumber('income'),
    expenses: readNumber('expenses'),
    fund: readNumber('fund'),
    sip: readNumber('sip'),
    goal: readNumber('goal'),
    years: Math.min(40, Math.round(readNumber('years'))),
    rate: Math.min(30, readNumber('rate'))
  };
}


/* charts (Chart.js) */

function buildCharts() {
  if (typeof Chart === 'undefined') return; // Chart.js did not load (offline)

  Object.values(charts).forEach(chart => chart.destroy());

  const dark = isDark();
  const accent = dark ? '#2dd4bf' : '#0f766e';

  Chart.defaults.color = dark ? '#94a3b8' : '#5b6b7a';
  Chart.defaults.borderColor = dark ? '#22313f' : '#dfe6e2';
  Chart.defaults.plugins.legend.position = 'bottom';

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 600, easing: 'easeOutQuart' }
  };

  // line chart: hover any year to compare all lines, click a year for the details
  charts.growth = new Chart(byId('growthChart'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Projected value',
          data: [],
          borderColor: accent,
          backgroundColor: dark ? 'rgba(45, 212, 191, .15)' : 'rgba(15, 118, 110, .15)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 6
        },
        {
          label: 'Amount invested',
          data: [],
          borderColor: '#94a3b8',
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: 'Goal',
          data: [],
          borderColor: '#f59e0b',
          borderDash: [6, 6],
          pointRadius: 0,
          pointHoverRadius: 0
        }
      ]
    },
    options: {
      ...baseOptions,
      interaction: { mode: 'index', intersect: false },
      onHover: (event, elements, chart) => {
        chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
      },
      onClick: (event, elements, chart) => {
        const points = chart.getElementsAtEventForMode(event, 'index', { intersect: false }, true);
        if (points.length) showYearDetails(chart, points[0].index);
      },
      scales: {
        y: { ticks: { callback: value => '₹' + shortAmount(value) } }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: item => ` ${item.dataset.label}: ${formatRupees(item.parsed.y)}`,
            footer: items => {
              const year = items[0].dataIndex;
              const [value, invested] = items[0].chart.data.datasets.map(set => set.data[year]);
              return 'Returns: ' + formatRupees(value - invested);
            }
          }
        }
      }
    }
  });

  charts.split = new Chart(byId('splitChart'), {
    type: 'doughnut',
    data: {
      labels: ['Invested', 'Returns'],
      datasets: [{
        data: [0, 0],
        backgroundColor: ['#94a3b8', accent],
        borderWidth: 0,
        hoverOffset: 12
      }]
    },
    options: {
      ...baseOptions,
      cutout: '65%',
      plugins: {
        tooltip: {
          callbacks: {
            label: item => {
              const total = item.dataset.data.reduce((sum, value) => sum + value, 0);
              const share = total ? Math.round(item.parsed / total * 100) : 0;
              return ` ${item.label}: ${formatRupees(item.parsed)} (${share}%)`;
            }
          }
        }
      }
    }
  });

  charts.rules = new Chart(byId('rulesChart'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{ data: [], backgroundColor: [] }]
    },
    options: {
      ...baseOptions,
      indexAxis: 'y',
      scales: {
        x: { display: false, min: 0, max: 1 }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: item => latest.r.rules[item.dataIndex].check,
            footer: items => latest.r.rules[items[0].dataIndex].pass ? 'Passed' : 'Not met yet'
          }
        }
      }
    }
  });
}

function showYearDetails(chart, year) {
  const value = chart.data.datasets[0].data[year];
  const invested = chart.data.datasets[1].data[year];

  byId('yearDetail').textContent =
    `Year ${year}: you invest ${formatRupees(invested)}, it grows to ${formatRupees(value)}, ` +
    `so your returns are ${formatRupees(value - invested)}.`;
}

function updateCharts(d, r, complete) {
  if (!charts.growth) return;

  const labels = [];
  const invested = [];
  const values = [];
  const goal = [];

  if (complete) {
    for (let year = 0; year <= d.years; year++) {
      labels.push('Year ' + year);
      invested.push(d.sip * 12 * year);
      values.push(Math.round(futureValue(d.sip, d.rate, year)));
      goal.push(d.goal || null); // no goal line when the goal is empty
    }
  }

  charts.growth.data.labels = labels;
  charts.growth.data.datasets[0].data = values;
  charts.growth.data.datasets[1].data = invested;
  charts.growth.data.datasets[2].data = goal;
  charts.growth.update();

  charts.split.data.datasets[0].data = complete
    ? [r.invested, Math.max(0, r.corpus - r.invested)]
    : [0, 0];
  charts.split.update();

  charts.rules.data.labels = complete ? r.rules.map(rule => rule.name) : [];
  charts.rules.data.datasets[0].data = complete ? r.rules.map(() => 1) : [];
  charts.rules.data.datasets[0].backgroundColor = r.rules.map(rule => rule.pass ? '#16a34a' : '#dc2626');
  charts.rules.update();
}


/* rendering */

function goalMessage(d, r, complete) {
  if (!complete) return 'Fill in the plan form to see your projection.';
  if (d.goal === 0) return 'Add a goal amount to see how your plan compares.';

  const goalName = d.goalType ? d.goalType.toLowerCase() + ' goal' : 'goal';

  if (r.corpus >= d.goal) {
    return `This covers your ${goalName} of ${formatRupees(d.goal)}.`;
  }
  return `This is ${formatRupees(d.goal - r.corpus)} short of your ${goalName} of ${formatRupees(d.goal)}.`;
}

function goalStatus(value, goal) {
  if (goal === 0) return '';
  if (value >= goal) return '<em class="good">Meets goal</em>';
  return `<em class="badtxt">Short by ${formatRupees(goal - value)}</em>`;
}

function renderTips(r, complete) {
  const failed = r.rules.filter(rule => !rule.pass);
  let html;

  if (!complete) {
    html = '<li class="muted">Fill in the plan form to get your next steps.</li>';
  } else if (failed.length === 0) {
    html = '<li class="good">All four rules are met. Keep your SIP running without breaks.</li>';
  } else {
    html = failed.map(rule => `<li>${escapeHtml(rule.tip)}</li>`).join('');
  }

  byId('tips').innerHTML = html;
}

function renderFundTypes(d, complete) {
  if (!complete) {
    byId('scen').innerHTML = '<p class="muted">Fill in the plan form to compare fund types.</p>';
    return;
  }

  byId('scen').innerHTML = fundTypes.map(fund => {
    const value = futureValue(d.sip, fund.rate, d.years);

    return `<div>
      <b>${fund.name}</b>
      <span>${fund.rate}% a year</span>
      <strong>${formatRupees(value)}</strong>
      ${goalStatus(value, d.goal)}
    </div>`;
  }).join('');
}

function render() {
  const d = readForm();
  const r = evaluate(d);
  const complete = d.sip > 0 && d.years > 0 && d.rate > 0; // enough to draw a projection
  const money = value => formatRupees(complete ? value : 0);

  latest = { d, r, complete };

  byId('heroYears').textContent = d.years || '–';
  byId('heroCorpus').textContent = money(r.corpus);
  byId('heroGoal').textContent = goalMessage(d, r, complete);
  byId('score').textContent = complete ? r.pct + '%' : '–';
  byId('verdict').textContent = complete ? r.verdict : 'Waiting for input';
  byId('verdict').className = complete ? 'pill ' + r.level : 'pill';
  byId('risk').textContent = complete ? r.risk : '–';

  byId('stInvested').textContent = money(r.invested);
  byId('stReturns').textContent = money(r.corpus - r.invested);
  byId('stTotal').textContent = money(r.corpus);
  byId('yearDetail').textContent = 'Click a year on the line chart to see its numbers.';

  byId('saveBtn').disabled = !complete;
  byId('reportBtn').disabled = !complete;

  renderTips(r, complete);
  renderFundTypes(d, complete);
  updateCharts(d, r, complete);
}


/* saved plans (localStorage, latest 20) */

function renderHistory() {
  const history = loadFromStorage('sipwiseHistory', []);

  if (history.length === 0) {
    byId('history').innerHTML = '<li class="muted">No saved plans yet. Press "Save this plan" to keep one.</li>';
    return;
  }

  byId('history').innerHTML = history.slice(0, 5).map(plan => {
    const type = plan.goalType ? ` (${escapeHtml(plan.goalType)})` : '';

    return `<li>
      <b>${escapeHtml(plan.name)}</b>${type}
      <span>${formatRupees(plan.sip)} a month for ${plan.years} years, score ${plan.pct}% (${escapeHtml(plan.verdict)}), saved ${escapeHtml(plan.date)}</span>
    </li>`;
  }).join('');
}

function savePlan() {
  const { d, r } = latest;
  const history = loadFromStorage('sipwiseHistory', []);

  history.unshift({
    name: d.name || 'Investor',
    goalType: d.goalType,
    sip: d.sip,
    years: d.years,
    pct: r.pct,
    verdict: r.verdict,
    date: new Date().toLocaleDateString('en-IN')
  });

  saveToStorage('sipwiseHistory', history.slice(0, 20));
  renderHistory();
}


/* report download (Blob + URL API) */

function downloadReport() {
  const { d, r } = latest;
  const name = d.name || 'Investor';

  const lines = [
    'SIPWISE GOAL PLAN REPORT',
    '',
    `Name: ${name}`,
    `Goal: ${d.goalType || 'Not chosen'} (${formatRupees(d.goal)})`,
    '',
    `Monthly income: ${formatRupees(d.income)}`,
    `Monthly expenses: ${formatRupees(d.expenses)}`,
    `Emergency fund: ${formatRupees(d.fund)}`,
    `Monthly SIP: ${formatRupees(d.sip)} for ${d.years} years at ${d.rate}% a year`,
    '',
    `Total invested: ${formatRupees(r.invested)}`,
    `Estimated returns: ${formatRupees(r.corpus - r.invested)}`,
    `Projected value: ${formatRupees(r.corpus)}`,
    '',
    `Readiness score: ${r.pct}% (${r.verdict})`,
    ...r.rules.map(rule => `  [${rule.pass ? 'PASS' : 'FAIL'}] ${rule.name}`),
    '',
    'Next steps:',
    ...r.rules.filter(rule => !rule.pass).map(rule => '  - ' + rule.tip),
    '',
    `Generated: ${new Date().toLocaleString('en-IN')}`,
    'Projections are estimates, not guaranteed returns or financial advice.'
  ];

  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sipwise_' + name.replace(/\s+/g, '_') + '.txt';
  link.click();
  URL.revokeObjectURL(url);
}


/* theme */

function setTheme(dark) {
  document.body.classList.toggle('dark', dark);
  byId('themeBtn').textContent = dark ? 'Light mode' : 'Dark mode';
  saveToStorage('sipwiseDark', dark);
  buildCharts();
  render();
}


/* start */

byId('docs').innerHTML = requiredDocs
  .map(doc => `<label><input type="checkbox"> ${doc}</label>`)
  .join('');

form.addEventListener('input', render);
form.addEventListener('submit', event => event.preventDefault()); // Enter should not reload the page
byId('saveBtn').addEventListener('click', savePlan);
byId('reportBtn').addEventListener('click', downloadReport);
byId('themeBtn').addEventListener('click', () => setTheme(!isDark()));
byId('clearBtn').addEventListener('click', () => {
  saveToStorage('sipwiseHistory', []);
  renderHistory();
});

// some browsers (Firefox especially) put old values back after a refresh,
// so start from an empty form every time the page is shown
window.addEventListener('pageshow', () => {
  form.reset();
  render();
});

renderHistory();
setTheme(loadFromStorage('sipwiseDark', window.matchMedia('(prefers-color-scheme: dark)').matches));
