package fileops

import (
	"os"
	"path/filepath"
	"testing"
)

func itemNames(list DirList) map[string]bool {
	names := make(map[string]bool, len(list.Items))
	for _, item := range list.Items {
		names[item.Name] = true
	}
	return names
}

func TestListDirIncludesHiddenByDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".hidden-file"), []byte("hidden"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "visible-file"), []byte("visible"), 0o600); err != nil {
		t.Fatal(err)
	}

	list, err := ListDir(ListDirOptions{Path: dir})
	if err != nil {
		t.Fatal(err)
	}

	names := itemNames(list)
	if !names[".hidden-file"] {
		t.Fatalf("expected hidden file in default ListDir result: %#v", names)
	}
	if !names["visible-file"] {
		t.Fatalf("expected visible file in default ListDir result: %#v", names)
	}
}

func TestListDirCanHideDotFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".hidden-file"), []byte("hidden"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "visible-file"), []byte("visible"), 0o600); err != nil {
		t.Fatal(err)
	}

	showHidden := false
	list, err := ListDir(ListDirOptions{Path: dir, ShowHidden: &showHidden})
	if err != nil {
		t.Fatal(err)
	}

	names := itemNames(list)
	if names[".hidden-file"] {
		t.Fatalf("did not expect hidden file when ShowHidden=false: %#v", names)
	}
	if !names["visible-file"] {
		t.Fatalf("expected visible file when ShowHidden=false: %#v", names)
	}
}
