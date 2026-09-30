import { sanity } from '../sanity.ts';
import { onetUrl } from './data.ts';

/** Domains whose elements have Level Scale Anchors, in the order competencies are picked. */
const COMPETENCY_DOMAINS = [
	{ domain: 'skills', sources: ['essentialSkills', 'transferableSkills'], take: 5 },
	{ domain: 'workActivities', sources: ['workActivities'], take: 3 },
	{ domain: 'knowledge', sources: ['knowledge'], take: 2 },
] as const;

type BriefRating = {
	domain: string;
	elementRef: string;
	name: string;
	description: string | null;
	scale: 'IM' | 'LV';
	value: number;
};

type BriefDoc = {
	code: string;
	title: string;
	description: string | null;
	jobZone: { level: number; name: string; experience: string | null } | null;
	coreTasks: string[] | null;
	workStyles: { name: string; description: string | null; impact: number }[] | null;
	hotTechnologies: string[] | null;
	ratings: BriefRating[] | null;
};

type Competency = {
	name: string;
	domain: string;
	description: string | null;
	importance: number;
	requiredLevel: number | null;
	elementRef: string;
};

/**
 * Everything the interview coach needs to write and grade questions for one occupation.
 * Each competency carries O*NET's Level Scale Anchors: concrete examples of what level 2, 4
 * and 6 (on the 0–7 Level scale) look like, which the coach uses as its grading rubric.
 */
export async function getInterviewBrief(code: string) {
	const doc = await sanity.fetch<BriefDoc | null>(
		`*[_type == "onetOccupation" && onetsocCode == $code][0]{
			"code": onetsocCode,
			title,
			description,
			"jobZone": jobZone->{"level": jobZone, name, experience},
			"coreTasks": tasks[taskType == "Core"][0...10].task,
			"workStyles": workStyles[scale->scaleId == "WI"] | order(dataValue desc)[0...5]{
				"name": element->elementName, "description": element->description, "impact": dataValue
			},
			"hotTechnologies": softwareSkills[hotTechnology == "Y"][0...8].workplaceExample,
			"ratings": ratings[
				domain in $domains && scale->scaleId in ["IM", "LV"] && notRelevant != "Y"
			]{
				domain,
				"elementRef": element._ref,
				"name": element->elementName,
				"description": element->description,
				"scale": scale->scaleId,
				"value": dataValue
			}
		}`,
		{ code, domains: COMPETENCY_DOMAINS.flatMap((d) => d.sources) },
	);
	if (!doc) {
		return { error: `No occupation found with O*NET-SOC code ${code}. Use searchOccupations to find a valid code.` };
	}

	const byElement = new Map<string, Competency>();
	for (const r of doc.ratings ?? []) {
		const domain = COMPETENCY_DOMAINS.find((d) => (d.sources as readonly string[]).includes(r.domain))!.domain;
		const entry = byElement.get(r.elementRef) ?? {
			name: r.name,
			domain,
			description: r.description,
			importance: 0,
			requiredLevel: null,
			elementRef: r.elementRef,
		};
		if (r.scale === 'IM') entry.importance = r.value;
		else entry.requiredLevel = r.value;
		byElement.set(r.elementRef, entry);
	}

	const picked = COMPETENCY_DOMAINS.flatMap(({ domain, take }) =>
		[...byElement.values()]
			.filter((c) => c.domain === domain)
			.sort((a, b) => b.importance - a.importance)
			.slice(0, take),
	);

	const anchors = await sanity.fetch<{ ref: string; level: number; example: string }[]>(
		`*[_type == "onetLevelScaleAnchor" && element._ref in $refs && scale->scaleId == "LV"]
			| order(anchorValue asc){"ref": element._ref, "level": anchorValue, "example": anchorDescription}`,
		{ refs: picked.map((c) => c.elementRef) },
	);

	return {
		code: doc.code,
		title: doc.title,
		url: onetUrl(doc.code),
		description: doc.description,
		jobZone: doc.jobZone,
		coreTasks: doc.coreTasks ?? [],
		hotTechnologies: doc.hotTechnologies ?? [],
		workStyles: doc.workStyles ?? [],
		competencies: picked.map(({ elementRef, ...c }) => ({
			...c,
			anchors: anchors.filter((a) => a.ref === elementRef).map(({ level, example }) => ({ level, example })),
		})),
	};
}
