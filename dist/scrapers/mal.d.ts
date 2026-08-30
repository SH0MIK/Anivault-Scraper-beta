export interface MalStreamingPlatform {
    name: string;
    url: string;
}
export interface MalAnimeDetails {
    malId: number;
    title: string;
    titleEnglish: string | null;
    titleJapanese: string | null;
    synopsis: string | null;
    image: string | null;
    type: string | null;
    episodes: number | null;
    status: string | null;
    aired: string | null;
    premiered: string | null;
    duration: string | null;
    rating: string | null;
    score: number | null;
    scoredBy: number | null;
    rank: number | null;
    popularity: number | null;
    members: number | null;
    genres: string[];
    studios: string[];
    source: string | null;
    streamingPlatforms: MalStreamingPlatform[];
}
export declare function getAnimeDetails(malId: number): Promise<MalAnimeDetails | null>;
export declare function getStreamingPlatforms(malId: number): Promise<MalStreamingPlatform[]>;
export interface MalSearchResult {
    malId: number;
    title: string;
    image: string | null;
    type: string | null;
    episodes: number | null;
    score: number | null;
    url: string;
}
export declare function searchAnime(query: string, limit?: number): Promise<MalSearchResult[]>;
export declare function debugSearchHtml(query: string): Promise<{
    status: number;
    length: number;
    hasBoxUnit1: boolean;
    snippet: string;
}>;
export interface MalEpisode {
    malId: number;
    url: string;
    title: string;
    titleJapanese: string | null;
    aired: string | null;
    filler: boolean;
    recap: boolean;
}
export interface MalEpisodePage {
    data: MalEpisode[];
    pagination: {
        currentPage: number;
        hasNextPage: boolean;
    };
}
export declare function getEpisodes(malId: number, page?: number): Promise<MalEpisodePage>;
export declare function getAllEpisodes(malId: number): Promise<MalEpisode[]>;
export declare function getEpisode(malId: number, epNum: number): Promise<MalEpisode | null>;
export interface MalVoiceActor {
    peopleId: number | null;
    name: string;
    url: string | null;
    image: string | null;
    language: string | null;
}
export interface MalCharacter {
    characterId: number | null;
    name: string;
    url: string | null;
    image: string | null;
    role: string | null;
    voiceActors: MalVoiceActor[];
}
export declare function getCharacters(malId: number): Promise<MalCharacter[]>;
export interface MalCharacterAnime {
    animeId: number | null;
    title: string;
    url: string | null;
    image: string | null;
    role: string | null;
}
export interface MalCharacterVA {
    peopleId: number | null;
    name: string;
    url: string | null;
    image: string | null;
    language: string | null;
}
export interface MalCharacterDetails {
    characterId: number;
    name: string;
    nameKanji: string | null;
    nicknames: string[];
    about: string | null;
    note: string | null;
    spoilers: string[];
    favorites: number | null;
    image: string | null;
    animeography: MalCharacterAnime[];
    voiceActors: MalCharacterVA[];
}
export declare function getCharacterDetails(characterId: number): Promise<MalCharacterDetails | null>;
export interface MalPicture {
    image: string;
    thumbnail: string | null;
}
export declare function getAnimePictures(malId: number): Promise<MalPicture[]>;
export declare function getCharacterPictures(characterId: number): Promise<MalPicture[]>;
export interface MalTheme {
    number: number;
    title: string;
    artist: string;
    episodes: string | null;
    spotifyUrl: string | null;
}
export declare function getAnimeThemes(malId: number): Promise<{
    opening: MalTheme[];
    ending: MalTheme[];
}>;
export interface MalVideo {
    label: string;
    youtubeId: string | null;
    embedUrl: string;
    songTitle: string | null;
    songArtist: string | null;
}
export declare function getAnimeVideos(malId: number): Promise<{
    musicVideos: MalVideo[];
    trailers: MalVideo[];
}>;
export interface MalRecommendation {
    animeId: number;
    title: string;
    image: string | null;
    votes: number;
}
export interface MalExternalLink {
    name: string;
    url: string;
}
export declare function getExternalLinks(malId: number): Promise<MalExternalLink[]>;
export declare function getRecommendations(malId: number): Promise<MalRecommendation[]>;
//# sourceMappingURL=mal.d.ts.map