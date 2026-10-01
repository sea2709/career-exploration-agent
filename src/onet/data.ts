import { sanity } from '../sanity.ts';

/** Ratings domains that carry paired Importance (IM, 1–5) and Level (LV, 0–7) scores. */
const IM_LV_DOMAINS = ['essentialSkills', 'transferableSkills', 'knowledge', 'abilities', 'workActivities'] as const;
type ImLvDomain = (typeof IM_LV_DOMAINS)[number];

export const onetUrl = (code: string) => `https://www.onetonline.org/link/summary/${code}`;

/** "All Other" catch-alls and military (55-) occupations have no tasks or ratings to recommend. */
const SEARCH_FILTER = `_type == "onetOccupation"
	&& !(title match "All Other")
	&& !string::startsWith(onetsocCode, "55-")
	&& (!defined($maxJobZone) || jobZone->jobZone <= $maxJobZone)`;

const SEARCH_PROJECTION = `{
	"code": onetsocCode,
	title,
	"jobZone": jobZone->jobZone,
	description
}`;

const SEARCH_DEPTH = 20;
const RRF_K = 60;

type SearchHit = { code: string; title: string; jobZone: number | null; description: string | null };

/**
 * Hybrid search: a keyword ranking and a semantic ranking (dataset embeddings), merged with
 * reciprocal rank fusion because their _score scales aren't comparable. Falls back to whichever
 * ranking succeeded, e.g. keyword only when embeddings are off or the semantic quota is used up.
 */
export async function searchOccupations(query: string, limit: number, maxJobZone?: number) {
	const params = { q: query, depth: SEARCH_DEPTH, maxJobZone: maxJobZone ?? null };
	const settled = await Promise.allSettled([
		sanity.fetch<SearchHit[]>(
			`*[${SEARCH_FILTER} && (title match $q || jobTitles[].jobTitle match $q || description match $q)]
			| score(boost(title match $q, 5), boost(jobTitles[].jobTitle match $q, 2), description match $q)
			| order(_score desc)[0...$depth]${SEARCH_PROJECTION}`,
			params,
		),
		sanity.fetch<SearchHit[]>(
			`*[${SEARCH_FILTER}]
			| score(text::semanticSimilarity($q))
			| order(_score desc)[0...$depth]${SEARCH_PROJECTION}`,
			params,
		),
	]);

	const rankings: SearchHit[][] = [];
	for (const result of settled) {
		if (result.status === 'fulfilled') rankings.push(result.value);
		else console.warn('[searchOccupations] A ranking failed, continuing without it:', result.reason);
	}
	if (!rankings.length) throw (settled[0] as PromiseRejectedResult).reason;

	const fused = new Map<string, { hit: SearchHit; score: number }>();
	for (const ranking of rankings) {
		ranking.forEach((hit, rank) => {
			const entry = fused.get(hit.code) ?? { hit, score: 0 };
			entry.score += 1 / (RRF_K + rank + 1);
			fused.set(hit.code, entry);
		});
	}
	const results = [...fused.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ hit }) => hit);

	return results.map((r) => ({
		...r,
		url: onetUrl(r.code),
		description: r.description && r.description.length > 220 ? `${r.description.slice(0, 220)}…` : r.description,
	}));
}

type RawRating = { domain: ImLvDomain; name: string; scale: 'IM' | 'LV'; value: number };

type ScoredElement = { name: string; importance: number; level: number | null };

/** Collapse IM/LV rows into one entry per element, grouped by domain and sorted by importance. */
function groupRatings(rows: RawRating[]) {
	const byDomain = new Map<ImLvDomain, Map<string, ScoredElement>>();
	for (const row of rows) {
		const domain = byDomain.get(row.domain) ?? new Map<string, ScoredElement>();
		byDomain.set(row.domain, domain);
		const entry = domain.get(row.name) ?? { name: row.name, importance: 0, level: null };
		if (row.scale === 'IM') entry.importance = row.value;
		else entry.level = row.value;
		domain.set(row.name, entry);
	}

	const result = {} as Record<ImLvDomain, ScoredElement[]>;
	for (const domain of IM_LV_DOMAINS) {
		result[domain] = [...(byDomain.get(domain)?.values() ?? [])].sort((a, b) => b.importance - a.importance);
	}
	return result;
}

const RATINGS_PROJECTION = `"ratings": ratings[
	domain in $imLvDomains && scale->scaleId in ["IM", "LV"] && notRelevant != "Y"
]{domain, "name": element->elementName, "scale": scale->scaleId, "value": dataValue}`;

type OccupationDoc = {
	code: string;
	title: string;
	description: string | null;
	jobZone: { level: number; name: string; education: string | null; experience: string | null } | null;
	coreTasks: string[] | null;
	alternateTitles: string[] | null;
	workStyles: { name: string; impact: number }[] | null;
	education: { scale: 'RL' | 'RQ'; category: string; percent: number }[] | null;
	hotTechnologies: string[] | null;
	ratings: RawRating[] | null;
};

async function fetchOccupation(code: string) {
	return sanity.fetch<OccupationDoc | null>(
		`*[_type == "onetOccupation" && onetsocCode == $code][0]{
			"code": onetsocCode,
			title,
			description,
			"jobZone": jobZone->{"level": jobZone, name, education, experience},
			"coreTasks": tasks[taskType == "Core"][0...8].task,
			"alternateTitles": jobTitles[0...10].jobTitle,
			"workStyles": workStyles[scale->scaleId == "WI"] | order(dataValue desc)[0...5]{
				"name": element->elementName, "impact": dataValue
			},
			"education": ratings[domain == "education" && scale->scaleId in ["RL", "RQ"] && dataValue > 0]
				| order(dataValue desc){"scale": scale->scaleId, "category": ratingCategory->categoryDescription, "percent": dataValue},
			"hotTechnologies": softwareSkills[hotTechnology == "Y"].workplaceExample,
			${RATINGS_PROJECTION}
		}`,
		{ code, imLvDomains: IM_LV_DOMAINS },
	);
}

/** O*NET reports required education on either the RL or RQ scale; prefer RL when both exist. */
function typicalEducation(rows: OccupationDoc['education']) {
	const all = rows ?? [];
	const preferred = all.some((r) => r.scale === 'RL') ? all.filter((r) => r.scale === 'RL') : all;
	return preferred.slice(0, 3).map(({ category, percent }) => ({ category, percent }));
}

const notFound = (code: string) => ({
	error: `No occupation found with O*NET-SOC code ${code}. Use searchOccupations to find a valid code.`,
});

export async function getOccupationProfile(code: string) {
	const doc = await fetchOccupation(code);
	if (!doc) return notFound(code);

	const ratings = groupRatings(doc.ratings ?? []);
	const skills = [...ratings.essentialSkills, ...ratings.transferableSkills].sort(
		(a, b) => b.importance - a.importance,
	);

	return {
		code: doc.code,
		title: doc.title,
		url: onetUrl(doc.code),
		description: doc.description,
		jobZone: doc.jobZone,
		typicalEducation: typicalEducation(doc.education),
		coreTasks: doc.coreTasks ?? [],
		alternateTitles: doc.alternateTitles ?? [],
		topSkills: skills.slice(0, 8),
		topKnowledge: ratings.knowledge.slice(0, 6),
		topAbilities: ratings.abilities.slice(0, 5),
		topWorkActivities: ratings.workActivities.slice(0, 5),
		workStyles: doc.workStyles ?? [],
		hotTechnologies: (doc.hotTechnologies ?? []).slice(0, 10),
	};
}

/**
 * Compare two occupations as a career move. Gaps are elements that matter in the target
 * (importance ≥ 3) where the target needs a higher level than the current occupation.
 */
export async function compareOccupations(fromCode: string, toCode: string) {
	const [from, to] = await Promise.all([fetchOccupation(fromCode), fetchOccupation(toCode)]);
	if (!from) return notFound(fromCode);
	if (!to) return notFound(toCode);

	const fromRatings = groupRatings(from.ratings ?? []);
	const toRatings = groupRatings(to.ratings ?? []);

	const compareDomain = (domains: ImLvDomain[]) => {
		const fromByName = new Map(domains.flatMap((d) => fromRatings[d]).map((e) => [e.name, e]));
		const targetElements = domains.flatMap((d) => toRatings[d]);

		const gaps = targetElements
			.filter((t) => t.importance >= 3 && t.level != null)
			.map((t) => {
				const current = fromByName.get(t.name);
				return {
					name: t.name,
					targetImportance: t.importance,
					targetLevel: t.level!,
					currentLevel: current?.level ?? 0,
					levelGap: +(t.level! - (current?.level ?? 0)).toFixed(2),
				};
			})
			.filter((g) => g.levelGap > 0.25)
			.sort((a, b) => b.levelGap * b.targetImportance - a.levelGap * a.targetImportance)
			.slice(0, 6);

		const sharedStrengths = targetElements
			.filter((t) => t.importance >= 3.5 && (fromByName.get(t.name)?.importance ?? 0) >= 3.5)
			.map((t) => t.name)
			.slice(0, 6);

		return { gaps, sharedStrengths };
	};

	const fromTech = new Set(from.hotTechnologies ?? []);

	return {
		from: { code: from.code, title: from.title, jobZone: from.jobZone?.level ?? null, url: onetUrl(from.code) },
		to: { code: to.code, title: to.title, jobZone: to.jobZone?.level ?? null, url: onetUrl(to.code) },
		jobZoneChange: (to.jobZone?.level ?? 0) - (from.jobZone?.level ?? 0),
		targetEducation: typicalEducation(to.education),
		skills: compareDomain(['essentialSkills', 'transferableSkills']),
		knowledge: compareDomain(['knowledge']),
		abilities: compareDomain(['abilities']),
		newTechnologiesToLearn: (to.hotTechnologies ?? []).filter((t) => !fromTech.has(t)).slice(0, 8),
	};
}

export async function getRelatedOccupations(code: string, limit: number) {
	const doc = await sanity.fetch<{
		title: string;
		related: { tier: string; code: string; title: string; jobZone: number | null }[] | null;
	} | null>(
		`*[_type == "onetOccupation" && onetsocCode == $code][0]{
			title,
			"related": relatedOccupations | order(relatedIndex asc)[0...$limit]{
				"tier": relatednessTier,
				"code": occupation->onetsocCode,
				"title": occupation->title,
				"jobZone": occupation->jobZone->jobZone
			}
		}`,
		{ code, limit },
	);
	if (!doc) return notFound(code);

	return {
		code,
		title: doc.title,
		url: onetUrl(code),
		related: (doc.related ?? []).map((r) => ({ ...r, url: onetUrl(r.code) })),
	};
}
