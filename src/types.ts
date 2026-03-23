export interface MindMapNode {
  title: string;
  content?: string;
  children?: MindMapNode[];
  id?: string;
  color?: string;
  textColor?: string;
}

export interface TreeNode extends d3.HierarchyPointNode<MindMapNode> {
  x: number;
  y: number;
}
