export interface CodeSymbol {
	name: string;
	kind: string;
	filePath: string;
	startLine: number;
	endLine: number;
	children?: CodeSymbol[];
}